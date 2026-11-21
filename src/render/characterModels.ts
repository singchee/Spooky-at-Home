import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Character models (zombie, survivor) from public/models/, baked into vertex animation textures.
 *
 * At load, each clip is played on the rigged model once, frame by frame, and every vertex's skinned
 * position and normal is written into a texture (one row per frame, one column per vertex). The game
 * then draws hundreds of characters with one instanced draw call per model: the vertex shader in
 * src/render/modelShader.ts reads each instance's two frames (and a second clip to blend from), so
 * there is no per-agent SkinnedMesh, no CPU skinning per frame, and no mixer per agent.
 *
 * Two extra columns hold tracked points the game needs: the top of the head (for the survivors' IR
 * strobe) and the middle of the chest (for their cold ID panel).
 *
 * Files come from our own origin only (hard rule 5); if loading or baking fails the game keeps the
 * procedural figures (src/render/figureShader.ts).
 */

/** Real human height the models are scaled to, metres. */
export const MODEL_HEIGHT = 1.75;
/** The zombie model is a cartoon with a head a third of its height; shrunk to this so it reads as a person from above. */
export const ZOMBIE_HEAD_SCALE = 0.62;
/** Frames baked per second of animation. */
const FPS = 30;

export interface BakedClip {
  name: string;
  /** First texture row, number of rows, seconds long, loops or holds its last frame. */
  row: number;
  frames: number;
  duration: number;
  loop: boolean;
  /** Frames per second baked (for clips that don't loop, frame = seconds x fps). */
  fps: number;
  /** Ground speed (m/s) the clip's stride matches at 1x, for locomotion clips; 0 when it doesn't walk. */
  stride: number;
}

export interface BakedModel {
  name: string;
  /** Indexed geometry in bind pose, with aVid (texture column), aHeatW (0 core … 1 hands and feet) and aRegion (0 skin, 1 top, 2 legs, 3 shoes, 4 hair). */
  geometry: THREE.BufferGeometry;
  /** Positions (xyz) and normals (xyz) per vertex per frame, half floats. */
  pos: THREE.DataTexture;
  nrm: THREE.DataTexture;
  clips: Record<string, BakedClip>;
  /** Texture columns of the tracked points. */
  headCol: number;
  chestCol: number;
  /** CPU copy of the tracked points per row: head x, y, z, chest x, y, z. */
  points: Float32Array;
  /** Direction the death clip falls toward, radians about +y from +z (model space). */
  deathDir: number;
  vertices: number;
  triangles: number;
  dispose(): void;
}

export interface CharacterModels {
  zombie: BakedModel;
  survivor: BakedModel;
}

/** Heat weight and clothing region from the name of the bone a vertex mostly follows. */
export function boneRegion(name: string): { heatW: number; region: number } {
  const n = name.toLowerCase();
  if (/head|neck|tongue|eye|jaw/.test(n)) return { heatW: 0, region: 0 };
  if (/torso|chest|spine2|upperchest/.test(n)) return { heatW: 0.62, region: 1 };
  if (/abdomen|spine/.test(n)) return { heatW: 0.7, region: 1 };
  if (/shoulder|upperarm/.test(n)) return { heatW: 0.76, region: 1 };
  if (/lowerarm|forearm/.test(n)) return { heatW: 0.88, region: 1 };
  if (/palm|hand|wrist|finger|thumb|index|middle|ring|pinky/.test(n)) return { heatW: 1, region: 0 };
  if (/hips|body|pelvis|root|^bone$/.test(n)) return { heatW: 0.8, region: 2 };
  if (/upperleg|thigh/.test(n)) return { heatW: 0.84, region: 2 };
  if (/lowerleg|shin|calf/.test(n)) return { heatW: 0.92, region: 2 };
  if (/foot|toe/.test(n)) return { heatW: 1, region: 3 };
  return { heatW: 0.8, region: 1 };
}

function findBone(bones: THREE.Bone[], re: RegExp): THREE.Bone | undefined {
  return bones.find((b) => re.test(b.name));
}

/** Clothing region from a material name (0 skin, 1 top, 2 legs, 3 shoes, 4 hair), or null when the name says nothing. */
export function materialRegion(name: string): number | null {
  const n = name.toLowerCase();
  if (/skin|eye|face/.test(n)) return 0;
  if (/shirt|top|jacket|coat|hood/.test(n)) return 1;
  if (/pant|trouser|jean|leg/.test(n)) return 2;
  if (/sock|shoe|boot|feet/.test(n)) return 3;
  if (/hair|beard/.test(n)) return 4;
  return null;
}

/** Posing helpers in world space (the model faces +z, its left is +x, y is up), for synthetic poses. */
export interface Rig {
  bone(name: RegExp): THREE.Bone | undefined;
  /** Turn `bone` so its length points along `dir` (world space). */
  aim(bone: THREE.Bone | undefined, dir: THREE.Vector3): void;
  /** World position of a bone. */
  at(bone: THREE.Bone | undefined): THREE.Vector3;
  /** Move the body (everything but IK feet) down by `d` world units. */
  lower(d: number): void;
}

function makeRig(bones: THREE.Bone[], scene: THREE.Object3D): Rig {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const wq = new THREE.Quaternion();
  const pq = new THREE.Quaternion();
  const root = bones.find((x) => /^body$/i.test(x.name)) ?? bones.find((x) => /^hips$/i.test(x.name)) ?? bones[0];
  return {
    bone: (re) => bones.find((x) => re.test(x.name)),
    aim(bone, dir) {
      if (!bone) return;
      scene.updateMatrixWorld(true);
      // The bone's length axis: toward its first child bone, or its local +y (how Blender bones point).
      const child = bone.children.find((c) => (c as THREE.Bone).isBone);
      bone.getWorldQuaternion(wq);
      let cur: THREE.Vector3;
      if (child) cur = child.getWorldPosition(b).sub(bone.getWorldPosition(a)).normalize();
      else cur = b.set(0, 1, 0).applyQuaternion(wq);
      q.setFromUnitVectors(cur, dir.clone().normalize());
      wq.premultiply(q);
      if (bone.parent) bone.parent.getWorldQuaternion(pq);
      else pq.identity();
      bone.quaternion.copy(pq.invert().multiply(wq));
      bone.updateMatrixWorld(true);
    },
    at(bone) {
      scene.updateMatrixWorld(true);
      return bone ? bone.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
    },
    lower(d) {
      root.getWorldPosition(a);
      a.y -= d;
      if (root.parent) root.parent.worldToLocal(a);
      root.position.copy(a);
      scene.updateMatrixWorld(true);
    },
  };
}

/**
 * The survivors' cower: squatting on bent knees, leaning forward, hands over the head. The survivor
 * model has no such clip, so it is posed here from the standing pose. The knees are solved with
 * two-bone IK onto the planted feet (the rig's feet are IK bones that don't follow the shins).
 */
export function cowerPose(rig: Rig): void {
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const side = (re: string, L: string) => rig.bone(new RegExp(`^${re}\\.?${L}$`, 'i'));
  // Leg lengths from the standing pose.
  const legs = ['L', 'R'].map((L) => {
    const hip = side('UpperLeg', L);
    const knee = side('LowerLeg', L);
    const foot = side('Foot', L);
    const H = rig.at(hip);
    const K = rig.at(knee);
    const F = rig.at(foot);
    return { L, hip, knee, foot, a: H.distanceTo(K), b: K.distanceTo(F) };
  });
  const len = legs[0].a + legs[0].b;
  rig.lower(len * 0.42);
  for (const g of legs) {
    const s = g.L === 'L' ? 1 : -1;
    const H = rig.at(g.hip);
    const F = rig.at(g.foot).add(V(0, g.b * 0.25, 0)); // the ankle, a little above the foot bone
    const d = Math.min(g.a + g.b - 1e-4, H.distanceTo(F));
    const u = F.clone().sub(H).normalize();
    const fwd = V(s * 0.3, 0, 1);
    const w = fwd.sub(u.clone().multiplyScalar(fwd.dot(u))).normalize();
    const cosA = Math.max(-1, Math.min(1, (g.a * g.a + d * d - g.b * g.b) / (2 * g.a * d)));
    const K = H.clone().add(u.clone().multiplyScalar(g.a * cosA)).add(w.multiplyScalar(g.a * Math.sqrt(1 - cosA * cosA)));
    rig.aim(g.hip, K.clone().sub(H));
    rig.aim(g.knee, F.clone().sub(rig.at(g.knee)));
  }
  rig.aim(rig.bone(/^abdomen$/i), V(0, 1, 0.45));
  rig.aim(rig.bone(/^torso$/i), V(0, 1, 0.75));
  rig.aim(rig.bone(/^neck$/i), V(0, 1, 0.9));
  for (const L of ['L', 'R']) {
    const s = L === 'L' ? 1 : -1;
    rig.aim(side('UpperArm', L), V(s * 0.45, 0.85, 0.35));
    // Forearm toward the top of the head: hands over it.
    const fore = side('LowerArm', L);
    const top = rig.at(rig.bone(/^head$/i)).add(V(-s * 0.05, 0.15, 0));
    rig.aim(fore, top.sub(rig.at(fore)));
  }
}

/**
 * Bake every clip of a loaded glTF into vertex animation textures. `loops` names the clips that
 * repeat; the rest hold their last frame (death).
 */
export function bakeModel(
  name: string,
  gltf: { scene: THREE.Object3D; animations: THREE.AnimationClip[] },
  loops: readonly string[],
  /** Shrinks the head (and what hangs off it) about the head bone: the zombie model is a big-headed cartoon. */
  headScale = 1,
  /** Extra one-frame "clips" posed in code from the standing pose (e.g. a cower the model has no clip for). */
  synth: Record<string, (rig: Rig) => void> = {},
): BakedModel {
  const scene = gltf.scene;
  const meshes: THREE.SkinnedMesh[] = [];
  scene.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh);
  });
  if (!meshes.length) throw new Error(`${name}: no skinned mesh`);
  const skeleton = meshes[0].skeleton;
  const bones = skeleton.bones;

  // Merge every skinned primitive into one vertex list (they share one skeleton).
  const vertsOf = meshes.map((m) => m.geometry.attributes.position.count);
  const nV = vertsOf.reduce((a, b) => a + b, 0);
  const cols = nV + 2;
  const headCol = nV;
  const chestCol = nV + 1;
  const index: number[] = [];
  const headW = new Float32Array(nV);
  const heatW = new Float32Array(nV);
  const region = new Float32Array(nV);
  const headBone = findBone(bones, /^head$/i) ?? findBone(bones, /head/i);
  const inHead = new Set<THREE.Object3D>();
  headBone?.traverse((o) => inHead.add(o));
  let base = 0;
  meshes.forEach((m, mi) => {
    const g = m.geometry;
    const idx = g.index;
    if (idx) for (let i = 0; i < idx.count; i++) index.push(base + idx.getX(i));
    else for (let i = 0; i < vertsOf[mi]; i++) index.push(base + i);
    const si = g.attributes.skinIndex;
    const sw = g.attributes.skinWeight;
    for (let i = 0; i < vertsOf[mi]; i++) {
      let best = 0;
      let bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (inHead.has(m.skeleton.bones[si.getComponent(i, k)])) headW[base + i] += w;
        if (w > bw) {
          bw = w;
          best = si.getComponent(i, k);
        }
      }
      const r = boneRegion(m.skeleton.bones[best]?.name ?? '');
      const mr = materialRegion((m.material as THREE.Material).name ?? '');
      heatW[base + i] = mr === 4 ? 0.45 : r.heatW; // hair insulates: the top of the head is cooler than the face
      region[base + i] = mr ?? r.region;
    }
    base += vertsOf[mi];
  });

  const head = headBone;
  const chest = findBone(bones, /^torso$/i) ?? findBone(bones, /chest|torso|spine/i);
  const footL = findBone(bones, /^foot\.?l$/i) ?? findBone(bones, /foot.*l/i);

  const mixer = new THREE.AnimationMixer(scene);
  const clips: Record<string, BakedClip> = {};
  let rows = 0;
  for (const c of gltf.animations) {
    const loop = loops.includes(c.name);
    const frames = Math.max(1, loop ? Math.round(c.duration * FPS) : Math.ceil(c.duration * FPS) + 1);
    clips[c.name] = { name: c.name, row: rows, frames, duration: c.duration, loop, fps: FPS, stride: 0 };
    rows += frames;
  }
  for (const n of Object.keys(synth)) {
    clips[n] = { name: n, row: rows, frames: 1, duration: 1, loop: true, fps: FPS, stride: 0 };
    rows += 1;
  }

  const raw = new Float32Array(cols * rows * 4);
  const rawN = new Float32Array(cols * rows * 4);
  const points = new Float32Array(rows * 6);
  const v = new THREE.Vector3();
  const tmp = new THREE.BufferGeometry();
  const tmpPos = new THREE.BufferAttribute(new Float32Array(nV * 3), 3);
  tmp.setAttribute('position', tmpPos);
  tmp.setIndex(index);
  const headP = new THREE.Vector3();
  const chestP = new THREE.Vector3();
  const headC = new THREE.Vector3();
  /** Skinned position of vertex i of mesh m (global index g) in the scene, head shrunk about the head bone. */
  const skinned = (m: THREE.SkinnedMesh, i: number, g: number, out: THREE.Vector3) => {
    m.applyBoneTransform(i, out.fromBufferAttribute(m.geometry.attributes.position, i)).applyMatrix4(m.matrixWorld);
    if (headScale !== 1 && headW[g] > 0) out.sub(headC).multiplyScalar(1 + (headScale - 1) * headW[g]).add(headC);
    return out;
  };

  const pose = (clip: THREE.AnimationClip | null, t: number) => {
    mixer.stopAllAction();
    if (clip) {
      const a = mixer.clipAction(clip);
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true; // the last frame of a clip is its end pose, not its first
      a.reset().play();
      mixer.setTime(t);
    }
    scene.updateMatrixWorld(true);
    for (const m of meshes) m.skeleton.update();
    if (headBone) headBone.getWorldPosition(headC);
  };

  // Scale and centre from the rest of the first looping clip's first frame (standing).
  const standClip = gltf.animations.find((c) => /idle/i.test(c.name)) ?? gltf.animations.find((c) => loops.includes(c.name)) ?? null;
  pose(standClip, 0);
  const box = new THREE.Box3();
  let g0 = 0;
  meshes.forEach((m, mi) => {
    for (let i = 0; i < vertsOf[mi]; i++) box.expandByPoint(skinned(m, i, g0 + i, v));
    g0 += vertsOf[mi];
  });
  const scale = MODEL_HEIGHT / Math.max(0.01, box.max.y - box.min.y);
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  const floor = box.min.y;
  const place = (p: THREE.Vector3) => p.set((p.x - cx) * scale, (p.y - floor) * scale, (p.z - cz) * scale);

  /** Writes the current pose into texture row `row`. */
  const bakeRow = (row: number) => {
    let o = 0;
    meshes.forEach((m, mi) => {
      for (let i = 0; i < vertsOf[mi]; i++) {
        place(skinned(m, i, o, v));
        tmpPos.setXYZ(o, v.x, v.y, v.z);
        const q = (row * cols + o) * 4;
        raw[q] = v.x;
        raw[q + 1] = v.y;
        raw[q + 2] = v.z;
        o++;
      }
    });
    tmp.deleteAttribute('normal');
    tmp.computeVertexNormals();
    const na = tmp.attributes.normal;
    for (let i = 0; i < nV; i++) {
      const q = (row * cols + i) * 4;
      rawN[q] = na.getX(i);
      rawN[q + 1] = na.getY(i);
      rawN[q + 2] = na.getZ(i);
    }
    // Tracked points: top of the head, and the front of the chest.
    if (head) {
      head.getWorldPosition(headP);
      place(headP);
      headP.y += 0.12 * headScale;
    }
    if (chest) {
      chest.getWorldPosition(chestP);
      place(chestP);
      chestP.y += 0.08;
    }
    const pts = [headP, chestP];
    pts.forEach((p, k) => {
      const q = (row * cols + nV + k) * 4;
      raw[q] = p.x;
      raw[q + 1] = p.y;
      raw[q + 2] = p.z;
      points[row * 6 + k * 3] = p.x;
      points[row * 6 + k * 3 + 1] = p.y;
      points[row * 6 + k * 3 + 2] = p.z;
    });
  };

  let deathDir = Math.PI;
  for (const c of gltf.animations) {
    const bc = clips[c.name];
    let footMin = Infinity;
    let footMax = -Infinity;
    for (let f = 0; f < bc.frames; f++) {
      const t = bc.loop ? (f / bc.frames) * c.duration : Math.min(c.duration, f / FPS);
      pose(c, t);
      bakeRow(bc.row + f);
      if (footL) {
        footL.getWorldPosition(v);
        place(v);
        footMin = Math.min(footMin, v.z);
        footMax = Math.max(footMax, v.z);
      }
    }
    // In-place walk cycles: the planted foot slides back across its range in about half the cycle.
    if (bc.loop && Number.isFinite(footMin)) bc.stride = (2 * (footMax - footMin)) / c.duration;
    if (/death/i.test(c.name)) {
      const a = bc.row * 6;
      const b = (bc.row + bc.frames - 1) * 6;
      deathDir = Math.atan2(points[b] - points[a], points[b + 2] - points[a + 2]);
    }
  }
  // Synthetic poses last (they move bones the clips may not animate).
  for (const [n, fn] of Object.entries(synth)) {
    pose(standClip, 0);
    fn(makeRig(bones, scene));
    scene.updateMatrixWorld(true);
    for (const m of meshes) m.skeleton.update();
    if (headBone) headBone.getWorldPosition(headC);
    bakeRow(clips[n].row);
  }
  mixer.stopAllAction();
  tmp.dispose();

  const half = (src: Float32Array) => {
    const out = new Uint16Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = THREE.DataUtils.toHalfFloat(src[i]);
    const tex = new THREE.DataTexture(out, cols, rows, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  };
  const pos = half(raw);
  const nrm = half(rawN);

  // Bind-pose geometry: the first frame of the standing clip, so the mesh has sensible bounds and normals.
  const geometry = new THREE.BufferGeometry();
  const bind = new Float32Array(nV * 3);
  const bindN = new Float32Array(nV * 3);
  const r0 = (standClip ? clips[standClip.name].row : 0) * cols;
  for (let i = 0; i < nV; i++) {
    bind.set([raw[(r0 + i) * 4], raw[(r0 + i) * 4 + 1], raw[(r0 + i) * 4 + 2]], i * 3);
    bindN.set([rawN[(r0 + i) * 4], rawN[(r0 + i) * 4 + 1], rawN[(r0 + i) * 4 + 2]], i * 3);
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(bind, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(bindN, 3));
  geometry.setAttribute('aVid', new THREE.BufferAttribute(Float32Array.from({ length: nV }, (_, i) => i), 1));
  geometry.setAttribute('aHeatW', new THREE.BufferAttribute(heatW, 1));
  geometry.setAttribute('aRegion', new THREE.BufferAttribute(region, 1));
  geometry.setIndex(index);

  // The rigged scene is no longer needed.
  for (const m of meshes) m.geometry.dispose();

  return {
    name,
    geometry,
    pos,
    nrm,
    clips,
    headCol,
    chestCol,
    points,
    deathDir,
    vertices: nV,
    triangles: index.length / 3,
    dispose() {
      geometry.dispose();
      pos.dispose();
      nrm.dispose();
    },
  };
}

let loading: Promise<CharacterModels | null> | null = null;

/**
 * Load and bake both models once (later calls share the same promise). Resolves to null when there
 * is no browser (tests) or anything fails; the caller then keeps the procedural figures.
 */
export function loadCharacterModels(): Promise<CharacterModels | null> {
  if (loading) return loading;
  if (typeof window === 'undefined' || typeof document === 'undefined') return (loading = Promise.resolve(null));
  const base = new URL(`${import.meta.env.BASE_URL}models/`, document.baseURI).href;
  // Our own origin only (hard rule 5).
  if (new URL(base).origin !== location.origin) return (loading = Promise.resolve(null));
  const loader = new GLTFLoader();
  const one = (file: string) => loader.loadAsync(base + file);
  loading = Promise.all([one('zombie.glb'), one('survivor.glb')])
    .then(([z, s]) => ({
      zombie: bakeModel('zombie', z, ['walk', 'run', 'runArms', 'attack'], ZOMBIE_HEAD_SCALE),
      survivor: bakeModel('survivor', s, ['idle', 'walk', 'run'], 1, { crouch: cowerPose }),
    }))
    .catch((e: unknown) => {
      console.warn('Character models failed to load; using the simple figures.', e);
      return null;
    });
  return loading;
}
