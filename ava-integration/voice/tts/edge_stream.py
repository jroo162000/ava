class EdgeStreamTTS:
    def __init__(self, voice: str = "en-US-MichelleNeural", output_format: str = "audio-24khz-16bit-mono-pcm"):
        self.voice = voice
        self.output_format = output_format
        self.current_sample_rate = 24000

    def speak(self, text: str, on_chunk):
        raise NotImplementedError("EdgeStreamTTS is not implemented in this minimal scaffold. Use Piper.")

    def stop(self):
        pass

