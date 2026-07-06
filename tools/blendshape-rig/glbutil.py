import numpy as np, pygltflib, io

def load_glb(path):
    g = pygltflib.GLTF2().load_binary(path)
    blob = g.binary_blob()
    def acc_arr(ai):
        a = g.accessors[ai]; bv = g.bufferViews[a.bufferView]
        comp = {5120:np.int8,5121:np.uint8,5122:np.int16,5123:np.uint16,5125:np.uint32,5126:np.float32}[a.componentType]
        n = {"SCALAR":1,"VEC2":2,"VEC3":3,"VEC4":4}[a.type]
        off = (bv.byteOffset or 0)+(a.byteOffset or 0)
        arr = np.frombuffer(blob, dtype=comp, count=a.count*n, offset=off)
        return arr.reshape(a.count, n) if n>1 else arr
    prim = g.meshes[0].primitives[0]
    P = acc_arr(prim.attributes.POSITION).astype(np.float64)
    UV = acc_arr(prim.attributes.TEXCOORD_0).astype(np.float64)
    F = acc_arr(prim.indices).astype(np.int64).reshape(-1,3)
    # node transform
    node = g.nodes[0]
    M = np.eye(4)
    if node.matrix: M = np.array(node.matrix).reshape(4,4).T
    else:
        S = np.diag((node.scale or [1,1,1])+[1.0])
        R = np.eye(4)
        if node.rotation:
            x,y,z,w = node.rotation
            R[:3,:3] = np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
        T = np.eye(4); T[:3,3] = node.translation or [0,0,0]
        M = T@R@S
    # base color image
    mat = g.materials[prim.material]
    img_idx = g.textures[mat.pbrMetallicRoughness.baseColorTexture.index].source
    bv = g.bufferViews[g.images[img_idx].bufferView]
    img_bytes = blob[(bv.byteOffset or 0):(bv.byteOffset or 0)+bv.byteLength]
    return g, P, UV, F, M, img_bytes

def raster(P2, F, W, H, UV=None, tex=None):
    """orthographic raster of already-projected pts P2 (N,3): x,y in [0,W/H] pixel coords, z depth (bigger=closer).
    returns rgb image, tri-id map, bary maps"""
    zbuf = np.full((H,W), -1e18); tid = np.full((H,W), -1, np.int64)
    b0m = np.zeros((H,W)); b1m = np.zeros((H,W))
    rgb = np.zeros((H,W,3), np.uint8)
    if tex is not None: th, tw = tex.shape[:2]
    for i,(a,b,c) in enumerate(F):
        pa,pb,pc = P2[a],P2[b],P2[c]
        area = (pb[0]-pa[0])*(pc[1]-pa[1])-(pb[1]-pa[1])*(pc[0]-pa[0])
        if area >= -1e-12: continue  # backface (CCW in flipped-y pixel space -> negative)
        x0=max(int(min(pa[0],pb[0],pc[0])),0); x1=min(int(max(pa[0],pb[0],pc[0]))+1,W)
        y0=max(int(min(pa[1],pb[1],pc[1])),0); y1=min(int(max(pa[1],pb[1],pc[1]))+1,H)
        if x0>=x1 or y0>=y1: continue
        xs,ys = np.meshgrid(np.arange(x0,x1)+0.5, np.arange(y0,y1)+0.5)
        w0 = ((pb[0]-pa[0])*(ys-pa[1])-(pb[1]-pa[1])*(xs-pa[0]))/area
        w1 = ((pc[0]-pb[0])*(ys-pb[1])-(pc[1]-pb[1])*(xs-pb[0]))/area
        w2 = 1-w0-w1
        inside = (w0>=0)&(w1>=0)&(w2>=0)
        if not inside.any(): continue
        z = w2*pa[2]+w0*pb[2]+w1*pc[2]  # note: w2 is weight of a? recompute properly below
        # barycentric: weight_a = signed area of (p, b, c)/area
        wa = ((pc[0]-pb[0])*(ys-pb[1])-(pc[1]-pb[1])*(xs-pb[0]))/area
        wb = ((pa[0]-pc[0])*(ys-pc[1])-(pa[1]-pc[1])*(xs-pc[0]))/area
        wc = 1-wa-wb
        inside = (wa>=-1e-9)&(wb>=-1e-9)&(wc>=-1e-9)
        z = wa*pa[2]+wb*pb[2]+wc*pc[2]
        sub = zbuf[y0:y1, x0:x1]
        upd = inside & (z > sub)
        if not upd.any(): continue
        sub[upd] = z[upd]; zbuf[y0:y1, x0:x1] = sub
        t = tid[y0:y1, x0:x1]; t[upd] = i; tid[y0:y1, x0:x1] = t
        bb0 = b0m[y0:y1,x0:x1]; bb0[upd]=wa[upd]; b0m[y0:y1,x0:x1]=bb0
        bb1 = b1m[y0:y1,x0:x1]; bb1[upd]=wb[upd]; b1m[y0:y1,x0:x1]=bb1
        if tex is not None and UV is not None:
            u = wa*UV[a,0]+wb*UV[b,0]+wc*UV[c,1-1]
            u = wa*UV[a,0]+wb*UV[b,0]+wc*UV[c,0]
            v = wa*UV[a,1]+wb*UV[b,1]+wc*UV[c,1]
            ui = np.clip((u*tw).astype(int),0,tw-1); vi = np.clip((v*th).astype(int),0,th-1)
            r = rgb[y0:y1,x0:x1]; r[upd] = tex[vi[upd], ui[upd]]; rgb[y0:y1,x0:x1]=r
    return rgb, tid, b0m, b1m, zbuf
