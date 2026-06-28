class VoiceProvider:
    def __init__(self, bus):
        self.bus = bus

    def start(self) -> None:
        pass

    def stop(self) -> None:
        pass

    def push_audio(self, pcm16: bytes) -> None:
        pass

