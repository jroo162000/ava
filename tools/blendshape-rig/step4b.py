import numpy as np, sys
sys.path.insert(0,'.')

P=np.load('P.npy'); F=np.load('F.npy'); SF=np.load('SF.npy')
w=np.load('w.npy'); si=np.load('si.npy')
samp_tri=np.load('samp_tri.npy'); samp_bary=np.load('samp_bary.npy')
dz=np.load('deltas_w.npz')
names=sorted(dz.files)

# weld groups by position
key = np.round(P*1e5).astype(np.int64)
_,grp = np.unique(key, axis=0, return_inverse=True)
ngrp = grp.max()+1
print('verts', len(P), 'welded groups', ngrp)

tri_of = samp_tri[si]; bar_of = samp_bary[si]
vidx = SF[tri_of]

# weld the weight field too
wg = np.zeros(ngrp); cnt = np.zeros(ngrp)
np.add.at(wg, grp, w); np.add.at(cnt, grp, 1)
w = (wg/cnt)[grp]

act = w>1e-4
# adjacency on WELDED graph
Fg = grp[F]
nbr={}
for a,b,c in Fg:
    for x,y in ((a,b),(b,c),(c,a)):
        if x!=y:
            nbr.setdefault(x,set()).add(y); nbr.setdefault(y,set()).add(x)
act_g = np.unique(grp[act])
nbr_list={i:np.array(list(nbr.get(i,[]))) for i in act_g}

out={}
for n in names:
    D=dz[n]
    dt=(bar_of[:,:,None]*D[vidx]).sum(1)*w[:,None]
    # weld-average
    dg=np.zeros((ngrp,3))
    np.add.at(dg, grp, dt); dg/=cnt[:,None]
    for _ in range(2):
        dg2=dg.copy()
        for i in act_g:
            nb=nbr_list[i]
            if len(nb): dg2[i]=0.4*dg[i]+0.6*dg[nb].mean(0)
        dg=dg2
    dt=dg[grp]
    dt[np.linalg.norm(dt,axis=1)<1e-5]=0
    out[n]=dt.astype(np.float32)
print('jawOpen max', round(float(np.linalg.norm(out['jawOpen'],axis=1).max()),4))
np.savez_compressed('target_deltas.npz', **out)
