import sys, os, importlib
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
try:
    m = importlib.import_module('voice.bus')
    print('OK', m.__file__)
except Exception as e:
    print('ERR', type(e).__name__, e)

