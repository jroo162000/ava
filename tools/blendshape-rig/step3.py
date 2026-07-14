import numpy as np, os, sys
from scipy.interpolate import RBFInterpolator
from scipy.spatial import cKDTree
sys.path.insert(0,'.')
from glbutil import load_glb

g,P,UV,F,M,_ = load_glb('/tmp/ava_head_new.glb')   # local==world (identity)
TL = np.load('target_lm3d.npy')                    # 478 target landmarks (3D)
SL = np.load('src_lm3d.npy'); SOK = np.load('src_lm_ok.npy')
SV = np.load('SV.npy'); SF = np.load('SF.npy')
use = SOK.copy()
src_c = SL[use]; tgt_c = TL[use]
print('correspondences:', use.sum())

# Umeyama similarity src->tgt
mu_s, mu_t = src_c.mean(0), tgt_c.mean(0)
A = (tgt_c-mu_t).T @ (src_c-mu_s) / len(src_c)
U,S,Vt = np.linalg.svd(A)
d = np.sign(np.linalg.det(U@Vt))
D = np.diag([1,1,d])
Rm = U@D@Vt
var_s = ((src_c-mu_s)**2).sum(1).mean()
s = np.trace(np.diag(S)@D)/var_s
t = mu_t - s*Rm@mu_s
def sim(x): return s*(Rm@x.T).T + t
res = np.linalg.norm(sim(src_c)-tgt_c,axis=1)
face_h = tgt_c[:,1].max()-tgt_c[:,1].min()
print('similarity residual mean/max:', res.mean().round(4), res.max().round(4), 'face h', face_h.round(3), 'scale', round(s,4))

# TPS warp on top of similarity
rbf = RBFInterpolator(sim(src_c), tgt_c, kernel='thin_plate_spline', smoothing=1e-6)
def warp(x): return rbf(sim(x))
res2 = np.linalg.norm(warp(src_c)-tgt_c,axis=1)
print('post-warp residual mean/max:', res2.mean().round(5), res2.max().round(5))

SVw = warp(SV)
np.save('SVw.npy', SVw)

# load all shapes, warp deltas through the field
names = sorted([f[:-4] for f in os.listdir('/tmp/dtx/data/ARKit_blendShapes') if f.endswith('.obj') and f!='Neutral.obj'])
def load_obj_v(p):
    return np.array([[float(x) for x in l.split()[1:4]] for l in open(p) if l.startswith('v ')])
deltas_w = {}
for n in names:
    Vs = load_obj_v(f'/tmp/dtx/data/ARKit_blendShapes/{n}.obj')
    deltas_w[n] = warp(Vs) - SVw
    mag = np.linalg.norm(deltas_w[n],axis=1).max()
np.savez_compressed('deltas_w.npz', **deltas_w)
print('shapes warped:', len(names))

# dense surface samples on warped source
nsub=6
bary=[]
for i in range(nsub+1):
    for j in range(nsub+1-i):
        k=nsub-i-j
        bary.append([i/nsub,j/nsub,k/nsub])
bary=np.array(bary)                        # 28 per tri
tri_v = SVw[SF]                            # (T,3,3)
samples = np.einsum('bk,tkd->tbd', bary, tri_v).reshape(-1,3)
samp_tri = np.repeat(np.arange(len(SF)), len(bary))
samp_bary = np.tile(bary,(len(SF),1))
# sample normals
fn = np.cross(tri_v[:,1]-tri_v[:,0], tri_v[:,2]-tri_v[:,0])
fn /= (np.linalg.norm(fn,axis=1,keepdims=True)+1e-12)
samp_n = np.repeat(fn, len(bary), axis=0)
tree = cKDTree(samples)
d, si = tree.query(P, workers=-1)

# target vertex normals
TN = np.zeros_like(P)
tfn = np.cross(P[F[:,1]]-P[F[:,0]], P[F[:,2]]-P[F[:,0]])
for i in range(3): np.add.at(TN, F[:,i], tfn)
TN /= (np.linalg.norm(TN,axis=1,keepdims=True)+1e-12)

sigma = 0.035*face_h
w = np.exp(-(d/sigma)**2)
ndot = (TN*samp_n[si]).sum(1)
w *= np.clip((ndot+0.2)/1.2, 0, 1)   # damp opposing normals (hair backs)
w[d>3*sigma]=0
print('verts with weight>0.01:', (w>0.01).sum(), '/', len(P), 'sigma', sigma.round(4))
np.save('w.npy',w); np.save('si.npy',si)
np.save('samp_tri.npy',samp_tri); np.save('samp_bary.npy',samp_bary)
np.save('P.npy',P)
