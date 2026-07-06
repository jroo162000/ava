import numpy as np, io, sys
from PIL import Image
sys.path.insert(0,'.')
from glbutil import load_glb, raster

g,P,UV,F,M,img_bytes = load_glb('/tmp/rig/ava_head_rigged.glb')
tex = np.asarray(Image.open(io.BytesIO(img_bytes)).convert('RGB'))
dz = np.load('target_deltas.npz')
TL = np.load('target_lm3d.npy')
# face crop window from landmarks
lo,hi = TL.min(0), TL.max(0)
c = (lo+hi)/2; span = max(hi[0]-lo[0], hi[1]-lo[1])*1.5
W=H=460
def render(Pd, name):
    P2=np.empty((len(Pd),3))
    P2[:,0]=(Pd[:,0]-c[0])/span*W+W/2
    P2[:,1]=-(Pd[:,1]-c[1])/span*H+H/2
    P2[:,2]=Pd[:,2]
    rgb,tid,b0,b1,zb = raster(P2,F,W,H,UV,tex)
    return rgb
tests = {'neutral':None,'jawOpen':1.0,'eyeBlink':None,'smile':None,'funnel':None}
imgs=[]
imgs.append(render(P,'neutral'))
imgs.append(render(P+dz['jawOpen'],'jawOpen'))
imgs.append(render(P+dz['eyeBlinkLeft']+dz['eyeBlinkRight'],'blink'))
imgs.append(render(P+dz['mouthSmileLeft']+dz['mouthSmileRight']+0.5*dz['jawOpen'],'smile+halfjaw'))
imgs.append(render(P+dz['mouthFunnel'],'funnel'))
imgs.append(render(P+dz['browInnerUp']+dz['eyeWideLeft']+dz['eyeWideRight'],'surprise'))
row1 = np.hstack(imgs[:3]); row2 = np.hstack(imgs[3:])
Image.fromarray(np.vstack([row1,row2])).save('preview.png')
print('previews rendered')
