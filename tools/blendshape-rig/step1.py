import numpy as np, io, sys
from PIL import Image
sys.path.insert(0,'.')
from glbutil import load_glb, raster

g,P,UV,F,M,img_bytes = load_glb('/tmp/ava_head_new.glb')
Pw = (M[:3,:3]@P.T).T + M[:3,3]
print('world bbox', Pw.min(0).round(3), Pw.max(0).round(3))
tex = np.asarray(Image.open(io.BytesIO(img_bytes)).convert('RGB'))
print('tex', tex.shape)
W=H=900
# assume faces +Z: project x->px, y->py(flip), depth=z
lo,hi = Pw.min(0), Pw.max(0)
span = max(hi[0]-lo[0], hi[1]-lo[1])*1.1
cx,cy = (lo[0]+hi[0])/2,(lo[1]+hi[1])/2
P2 = np.empty((len(Pw),3))
P2[:,0] = (Pw[:,0]-cx)/span*W + W/2
P2[:,1] = -(Pw[:,1]-cy)/span*H + H/2
P2[:,2] = Pw[:,2]
rgb,tid,b0,b1,zb = raster(P2,F,W,H,UV,tex)
Image.fromarray(rgb).save('front.png')
np.savez_compressed('front_maps.npz', tid=tid,b0=b0,b1=b1)
np.save('Pw.npy',Pw); np.save('F.npy',F)
print('rendered, coverage', (tid>=0).mean().round(3))
