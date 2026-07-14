import numpy as np, pygltflib, struct

g = pygltflib.GLTF2().load_binary('/tmp/ava_head_new.glb')
blob = bytearray(g.binary_blob())
dz = np.load('target_deltas.npz')
names = sorted(dz.files)
prim = g.meshes[0].primitives[0]
targets=[]
for n in names:
    D = dz[n].astype(np.float32)
    data = D.tobytes()
    while len(blob)%4: blob.append(0)
    off=len(blob); blob.extend(data)
    g.bufferViews.append(pygltflib.BufferView(buffer=0, byteOffset=off, byteLength=len(data)))
    bv = len(g.bufferViews)-1
    g.accessors.append(pygltflib.Accessor(bufferView=bv, componentType=5126, count=len(D), type="VEC3",
        min=[float(x) for x in D.min(0)], max=[float(x) for x in D.max(0)]))
    targets.append(pygltflib.Attributes(POSITION=len(g.accessors)-1))
prim.targets=[{"POSITION": t.POSITION} for t in targets]
g.meshes[0].weights=[0.0]*len(names)
if g.meshes[0].extras is None: g.meshes[0].extras={}
g.meshes[0].extras['targetNames']=names
g.buffers[0].byteLength=len(blob)
g.set_binary_blob(bytes(blob))
g.save_binary('/tmp/rig/ava_head_rigged.glb')
import os; print('written', os.path.getsize('/tmp/rig/ava_head_rigged.glb'), 'bytes,', len(names),'targets')
