# AVA Local Voice Setup (Vosk + Whisper + Piper/Edge)

This guide gets AVA’s local voice path running: Vosk (streaming), Whisper (finals), and Piper/Edge TTS.

## Requirements

- Python venv with deps: `pip install -r requirements.txt`
- Microphone device: iTalk (you mentioned this is correct)
- Models downloaded to the paths below

## Model Downloads

- Vosk (English, small):
  - https://alphacephei.com/vosk/models (vosk-model-small-en-us-0.15)
  - Place at: `C:\Users\USER 1\ava\ava-integration\vosk-models\vosk-model-small-en-us-0.15`

- Piper voice (e.g., en_US-lessac-medium.onnx):
  - https://github.com/rhasspy/piper/releases or voice model mirrors
  - Place at: `C:\Users\USER 1\ava\ava-integration\vendor\piper\models\en_US-lessac-medium.onnx`

## Configuration

- File: `C:\Users\USER 1\ava\ava-integration\ava_voice_config.json`
  - `local_fallback.piper.exe` -> already set to repo copy
  - `local_fallback.piper.model` -> already set to `vendor/piper/models/en_US-lessac-medium.onnx`
  - `audio.input_device` -> set to your iTalk index

Find your device index:

```
cd "C:\Users\USER 1\ava\ava-integration"
python test_audio_devices.py
```

Look for the iTalk device and note the `[index]`. Update `ava_voice_config.json`:

```
"audio": {
  "input_device": <your_index>,
  "input_device_name": "Microphone (3- iTalk-02)"
}
```

## Entry Point

- Use the launcher: `C:\Users\USER 1\ava\ava-integration\start_ava_standalone_realtime.bat`
  - It runs from its own folder and writes logs to:
    - `standalone.out.log`, `standalone.err.log`

## Notes

- Unified local voice via `ava_standalone_realtime.py` is the active path in this repo.
- Do not use `C:\Users\USER 1\ava-integration` as the default runtime tree; that sibling checkout is older.
- Deepgram/OpenAI keys are not required for local voice. (This mode uses Vosk/Whisper + Piper/Edge.)
- If Piper outputs at 22050 Hz, AVA will resample to your playback rate automatically.

## Troubleshooting

- Missing models: ensure the folders above exist and contain the model files.
- No mic input: run `test_audio_devices.py`, update `input_device` accordingly.
- Choppy TTS: AVA uses a playback thread + queue; if you hear gaps, check CPU load and logs.

