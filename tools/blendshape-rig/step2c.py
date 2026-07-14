import numpy as np, sys
from PIL import Image
sys.path.insert(0,'.')
from glbutil import raster
from mediapipe.python.solutions import face_mesh as mpfm

def load_obj(p):
    V=[];Fc=[]
    for line in open(p):
        if line.startswith('v '): V.append([float(x) for x in line.split()[1:4]])
        elif line.startswith('f '):
            idx=[int(t.split('/')[0])-1 for t in line.split()[1:]]
            for k in range(1,len(idx)-1): Fc.append([idx[0],idx[k],idx[k+1]])
    return np.array(V), np.array(Fc)

SV,SF = load_obj('/tmp/dtx/data/ARKit_blendShapes/Neutral.obj')
np.save('SV.npy',SV); np.save('SF.npy',SF)
lm={};exec(open('/tmp/dtx/landmarks/LARkit.py').read(),{'np':np},lm);LM=lm['LM']
eyes=(SV[LM[1]]+SV[LM[2]]+SV[LM[3]]+SV[LM[4]])/4
mouth=(SV[LM[7]]+SV[LM[10]])/2
nose=SV[LM[0]]
u=eyes-mouth;u/=np.linalg.norm(u)
r=SV[LM[1]]-SV[LM[3]]
r-=u*np.dot(r,u);r/=np.linalg.norm(r)
f=np.cross(r,u)
fc=(eyes+mouth)/2
if np.dot(f,nose-fc)<0: r=-r;f=-f
R=np.stack([r,u,f])
Vr=(R@(SV-fc).T).T
np.save('R_src.npy',R);np.save('fc_src.npy',fc)
print('rot bbox',Vr.min(0).round(1),Vr.max(0).round(1),'nose z',(R@(nose-fc)).round(1))
W=H=900
lo,hi=Vr.min(0),Vr.max(0)
span=max(hi[0]-lo[0],hi[1]-lo[1])*1.15
cx,cy=(lo[0]+hi[0])/2,(lo[1]+hi[1])/2
P2=np.empty((len(Vr),3))
P2[:,0]=(Vr[:,0]-cx)/span*W+W/2;P2[:,1]=-(Vr[:,1]-cy)/span*H+H/2;P2[:,2]=Vr[:,2]
N=np.zeros_like(Vr)
fn=np.cross(Vr[SF[:,1]]-Vr[SF[:,0]],Vr[SF[:,2]]-Vr[SF[:,0]])
for i in range(3): np.add.at(N,SF[:,i],fn)
N/=(np.linalg.norm(N,axis=1,keepdims=True)+1e-12)
shade=np.clip(N[:,2],0,1)*0.7+0.3
col=np.stack([shade*225,shade*175,shade*145],1).astype(np.uint8)
rgb,tid,b0,b1,zb=raster(P2,SF,W,H)
img=np.zeros((H,W,3),np.uint8)
mask=tid>=0;ys,xs=np.nonzero(mask);t=tid[mask].astype(int)
wa,wb=b0[mask],b1[mask];wc=1-wa-wb
img[ys,xs]=(wa[:,None]*col[SF[t,0]]+wb[:,None]*col[SF[t,1]]+wc[:,None]*col[SF[t,2]]).astype(np.uint8)
Image.fromarray(img).save('src_front3.png')
with mpfm.FaceMesh(static_image_mode=True,refine_landmarks=True,max_num_faces=1,min_detection_confidence=0.2) as fm:
    res=fm.process(img)
if res.multi_face_landmarks:
    pts=np.array([[l.x*W,l.y*H] for l in res.multi_face_landmarks[0].landmark])
    P3=[];ok=[]
    for x,y in pts:
        xi,yi=int(round(x)),int(round(y))
        if not(0<=xi<W and 0<=yi<H) or tid[yi,xi]<0: ok.append(False);P3.append([0,0,0]);continue
        a,b,c=SF[tid[yi,xi]];wa,wb=b0[yi,xi],b1[yi,xi];wc=1-wa-wb
        P3.append(wa*SV[a]+wb*SV[b]+wc*SV[c]);ok.append(True)
    P3=np.array(P3);ok=np.array(ok)
    print('src landmarks:',ok.sum(),'/',len(ok))
    np.save('src_lm3d.npy',P3);np.save('src_lm_ok.npy',ok)
else:
    print('NO DETECTION on source render')
