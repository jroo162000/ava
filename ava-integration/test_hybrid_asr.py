"""
Test script for hybrid VOSK + Whisper ASR
"""
import sys
import os
import time
import json

# Test 1: Verify VOSK loads
print("=" * 50)
print("TEST 1: VOSK Model Loading")
print("=" * 50)

try:
    from vosk import Model, KaldiRecognizer, SetLogLevel
    SetLogLevel(-1)  # Suppress logs
    
    vosk_model_path = r"C:\Users\USER 1\ava-integration\vosk-models\vosk-model-small-en-us-0.15"
    
    if os.path.exists(vosk_model_path):
        print(f"✅ Model path exists: {vosk_model_path}")
        
        model = Model(vosk_model_path)
        recognizer = KaldiRecognizer(model, 16000)
        print("✅ VOSK model loaded successfully!")
        
        # Quick test with silence
        silent_audio = bytes(16000 * 2)  # 1 second of silence
        recognizer.AcceptWaveform(silent_audio)
        result = json.loads(recognizer.FinalResult())
        print(f"✅ VOSK responds to audio (empty result expected): '{result.get('text', '')}'")
        
    else:
        print(f"❌ Model path not found: {vosk_model_path}")
        
except ImportError as e:
    print(f"❌ VOSK import error: {e}")
except Exception as e:
    print(f"❌ VOSK error: {e}")

# Test 2: Verify Whisper loads  
print("\n" + "=" * 50)
print("TEST 2: Whisper Model Loading")
print("=" * 50)

try:
    from faster_whisper import WhisperModel
    
    print("Loading Whisper base.en model...")
    model = WhisperModel("base.en", device="cpu", compute_type="int8")
    print("✅ Whisper model loaded successfully!")
    
    # Quick test with silence
    import numpy as np
    silent_audio = np.zeros(16000, dtype=np.float32)  # 1 second
    segments, info = model.transcribe(silent_audio, beam_size=5, language="en")
    text = " ".join([seg.text for seg in segments]).strip()
    print(f"✅ Whisper responds to audio (empty or noise expected): '{text[:50] if text else '(empty)'}'")
    
except ImportError as e:
    print(f"❌ Whisper import error: {e}")
except Exception as e:
    print(f"❌ Whisper error: {e}")

# Test 3: Check config
print("\n" + "=" * 50)
print("TEST 3: Config Check")
print("=" * 50)

config_path = r"C:\Users\USER 1\ava-integration\ava_voice_config.json"
try:
    with open(config_path, 'r') as f:
        cfg = json.load(f)
    
    local_cfg = cfg.get('local_fallback', {})
    hybrid_cfg = local_cfg.get('hybrid', {})
    
    print(f"ASR Mode: {local_cfg.get('asr_mode', 'not set')}")
    print(f"Whisper Model: {local_cfg.get('whisper_model', 'not set')}")
    print(f"VOSK Model Path: {local_cfg.get('vosk_model_path', 'not set')}")
    print(f"Show VOSK Partials: {hybrid_cfg.get('show_vosk_partial', 'not set')}")
    print(f"Silence Timeout: {hybrid_cfg.get('silence_timeout_sec', 'not set')}s")
    print(f"Min Audio: {hybrid_cfg.get('min_audio_sec', 'not set')}s")
    
    if local_cfg.get('asr_mode') == 'hybrid':
        print("\n✅ Hybrid mode is configured!")
    else:
        print(f"\n⚠️ ASR mode is '{local_cfg.get('asr_mode')}', not 'hybrid'")
        
except Exception as e:
    print(f"❌ Config error: {e}")

print("\n" + "=" * 50)
print("TEST COMPLETE")
print("=" * 50)
