import os, subprocess, sys

WD = os.path.dirname(__file__)
exe = os.path.join(WD, 'vendor', 'piper', 'piper.exe')
model = os.path.join(WD, 'vendor', 'piper', 'models', 'en_US-lessac-medium.onnx')
es = os.path.join(WD, 'vendor', 'piper', 'espeak-ng-data')
out = os.path.join(WD, 'piper_test.wav')

text = 'Testing unified voice from Piper.'
if len(sys.argv) > 1:
    text = ' '.join(sys.argv[1:])

args = [exe, '-m', model, '--espeak_data', es, '-f', out]
p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
p.stdin.write((text + '\n').encode('utf-8', errors='ignore'))
p.stdin.flush(); p.stdin.close()
stdout, stderr = p.communicate(timeout=10)
print('RC', p.returncode)
print('STDERR', stderr.decode('utf-8', errors='ignore').strip()[:200])
print('OUT_EXISTS', os.path.exists(out), 'SIZE', os.path.getsize(out) if os.path.exists(out) else 0)

