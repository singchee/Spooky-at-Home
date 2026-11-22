# Character models: credits and licences

The two character models in this folder are trimmed copies of files from an npm package. They are
served from our own origin only (no runtime calls to any other host).

| File | Size | SHA-256 | Made from |
|---|---|---|---|
| `zombie.glb` | 220,004 bytes | `478e0097a397b91f72206c30c3900c5ce967eaea5b84cba60285a0742c94cadf` | `library/lowpoly/zombie.glb` (source SHA-256 `55002b53e87fe087fc67162efd6d680072f954b56160db3753a6dc3aac826231`) |
| `survivor.glb` | 145,292 bytes | `8cad515cc3e52fd447fc9c8767de6236ca0866a7cbb644558e9b5fbf327dc3eb` | `library/lowpoly/worker.glb` (source SHA-256 `ba034a087e5f26c43da0f8213dd3cb5cbcee057bf195fde4f66f5aa2951b7727`) |

**Source package:** `@netforge/asset-library-files` version **0.2.0** on npm (fetched with
`npm pack @netforge/asset-library-files@0.2.0`; not a dependency of this project).

**Apparent upstream: Quaternius (CC0), unverified — owner to confirm.** The package's `NOTICE` file
says its `lowpoly` models are optimised copies of Quaternius models (https://quaternius.com) released
under CC0 1.0, taken from Quaternius's Poly Pizza uploads that state Public Domain (CC0). The armature
names (`CharacterArmature`, `HumanArmature`) match Quaternius's character packs. We have not checked
the Quaternius or Poly Pizza pages ourselves (they are blocked from the build machine).

**What we changed** (`tools/prep-models.mjs`, reproducible): kept only the animation clips the game
uses and gave them short names (zombie: walk, run, runArms, attack, hit, death; survivor: idle,
walk, run, death); removed textures, UVs and normals (the game draws sensor values, not the models'
colours); removed the zombie's eyelid mesh; welded and simplified the meshes (zombie 7,570 → 999
triangles, survivor 1,852 → 1,384); wrote plain quantised glTF (no meshopt compression, whose
WebAssembly decoder our Content-Security-Policy does not allow). At load the game also shrinks the
zombie's oversized cartoon head and bakes a cowering pose for the survivor
(`src/render/characterModels.ts`).

## The package's licence (MIT), verbatim

```
MIT License

Copyright (c) 2026 NetNet Capital Management

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The package's `NOTICE` also says: "The files in library/ are optimized copies (meshopt, resized
textures) of third-party art under CC0 1.0 (public domain dedication) … Crediting is not required by
CC0; we credit anyway." We credit Quaternius here for the same reason.
