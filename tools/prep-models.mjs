// Prepares the character models in public/models/ from the CC0 asset package (see public/models/CREDITS.md).
// Not part of the build and not a dependency: run it by hand when the models change.
//
//   mkdir /tmp/gt && cd /tmp/gt && npm init -y && npm i @gltf-transform/core@4 @gltf-transform/extensions@4 @gltf-transform/functions@4 meshoptimizer
//   npm pack @netforge/asset-library-files@0.2.0 && tar xzf netforge-asset-library-files-0.2.0.tgz
//   node <repo>/tools/prep-models.mjs /tmp/gt/package/library/lowpoly <repo>/public/models
//
// For each model: keep only the clips the game uses (renamed to short names), drop textures, UVs and
// materials (the game draws sensor values, not the model's colours) and normals (the game computes
// smooth ones), weld and simplify the mesh to a triangle budget, and write plain quantised glTF (KHR_mesh_quantization). No meshopt compression:
// its decoder is WebAssembly, which the site's Content-Security-Policy does not allow.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const req = createRequire(`${process.cwd()}/`);
const load = (m) => import(req.resolve(m));
const { NodeIO } = await load('@gltf-transform/core');
const { ALL_EXTENSIONS, KHRMeshQuantization } = await load('@gltf-transform/extensions');
const F = await load('@gltf-transform/functions');
const { MeshoptDecoder, MeshoptSimplifier } = await load('meshoptimizer');
await MeshoptDecoder.ready;
await MeshoptSimplifier.ready;

const [src, out] = process.argv.slice(2);
if (!src || !out) throw new Error('usage: node tools/prep-models.mjs <lowpoly dir> <out dir>');
mkdirSync(out, { recursive: true });

/** Output file, source file, clips to keep (source name → short name), mesh nodes to drop, triangle budget. */
const MODELS = [
  {
    out: 'zombie.glb',
    src: 'zombie.glb',
    clips: { 'CharacterArmature|Walk': 'walk', 'CharacterArmature|Run': 'run', 'CharacterArmature|Run_Arms': 'runArms', 'CharacterArmature|Idle_Attack': 'attack', 'CharacterArmature|HitReact': 'hit', 'CharacterArmature|Death': 'death' },
    dropMeshes: ['Eyelid'],
    tris: 1000,
  },
  {
    out: 'survivor.glb',
    src: 'worker.glb',
    clips: { 'HumanArmature|Man_Idle': 'idle', 'HumanArmature|Man_Walk': 'walk', 'HumanArmature|Man_Run': 'run', 'HumanArmature|Man_Death': 'death' },
    dropMeshes: [],
    tris: 1400,
  },
];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const report = [];
for (const m of MODELS) {
  const doc = await io.read(`${src}/${m.src}`);
  const root = doc.getRoot();
  // Drop the meshopt extension (we write uncompressed buffers).
  for (const ext of root.listExtensionsUsed()) if (ext.extensionName === 'EXT_meshopt_compression') ext.dispose();
  for (const n of root.listNodes()) if (m.dropMeshes.includes(n.getMesh()?.getName())) n.dispose();
  for (const a of root.listAnimations()) {
    const short = m.clips[a.getName()];
    if (short) a.setName(short);
    else a.dispose();
  }
  // No textures or UVs: colours come from the game's sensor shader. Materials are kept only as names
  // (Skin, Shirt, Pants, Hair…), which tell the game which parts are skin, clothes and hair.
  for (const mesh of root.listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      for (const s of p.listSemantics()) if (s.startsWith('TEXCOORD') || s.startsWith('COLOR')) p.setAttribute(s, null);
      p.setAttribute('NORMAL', null);
    }
  }
  for (const x of root.listMaterials()) {
    x.setBaseColorTexture(null);
    x.setNormalTexture(null);
    x.setEmissiveTexture(null);
    x.setOcclusionTexture(null);
    x.setMetallicRoughnessTexture(null);
  }
  for (const t of root.listTextures()) t.dispose();
  await doc.transform(F.dequantize(), F.join({ keepNamed: false }), F.weld({}));
  let tris = 0;
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) tris += p.getIndices().getCount() / 3;
  const ratio = Math.min(1, m.tris / tris);
  await doc.transform(
    F.simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.02, lockBorder: false }),
    F.resample(),
    F.prune(),
    F.dedup(),
    F.quantize({ quantizePosition: 14, quantizeWeight: 8 }),
  );
  let after = 0;
  let verts = 0;
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    after += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3;
    if (!p.getIndices()) console.warn(m.out, 'unindexed primitive', mesh.getName(), p.getAttribute('POSITION').getCount());
    verts += p.getAttribute('POSITION').getCount();
  }
  const bytes = await io.writeBinary(doc);
  writeFileSync(`${out}/${m.out}`, bytes);
  report.push({ file: m.out, from: m.src, trianglesBefore: tris, triangles: after, vertices: verts, clips: root.listAnimations().map((a) => a.getName()), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
console.log(JSON.stringify(report, null, 2));
// Hash of the source files too, for the credits.
for (const m of MODELS) console.log(m.src, createHash('sha256').update(readFileSync(`${src}/${m.src}`)).digest('hex'));
void KHRMeshQuantization;
