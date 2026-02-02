import os
import sys
import pyaudio
import threading
import time
import logging
from logging.handlers import RotatingFileHandler
from typing import Optional

from deepgram import DeepgramClient
from deepgram.core.events import EventType
from deepgram.extensions.types.sockets import (
    AgentV1Agent,
    AgentV1AudioConfig,
    AgentV1AudioInput,
    AgentV1AudioOutput,
    AgentV1DeepgramSpeakProvider,
    AgentV1GoogleThinkProvider,
    AgentV1Listen,
    AgentV1ListenProvider,
    AgentV1SettingsMessage,
    AgentV1SocketClientResponse,
    AgentV1SpeakProviderConfig,
    AgentV1Think,
)

# PyAudio / audio I/O constants
FORMAT = pyaudio.paInt16
CHANNELS = 1
RATE = 16000  # microphone capture rate
CHUNK = 480   # ~30ms at 16kHz for lower latency than 1024

# Global state
shutdown_event = threading.Event()
connection_active = threading.Event()


def _rms_int16(frame: bytes) -> float:
    # Compute RMS over int16 mono/averaged samples
    if not frame:
        return 0.0
    count = len(frame) // 2
    if count == 0:
        return 0.0
    import struct
    samples = struct.unpack('<' + 'h' * count, frame)
    # average for mono; if stereo it would average channels but we capture mono
    acc = 0.0
    for s in samples:
        acc += (s * s)
    return (acc / count) ** 0.5


class WavToPcmStripper:
    """Strips WAV header and forwards only PCM data bytes.

    Reset this between clips (e.g., on AgentAudioDone).
    Tolerates data chunk size of 0 by streaming until reset.
    """

    def __init__(self):
        self.reset()

    def reset(self):
        self._need_header = True
        self._buffer = bytearray()
        self._data_started = False

    def feed(self, data: bytes) -> bytes:
        if not data:
            return b''
        if not self._need_header:
            return data  # already in data section
        # accumulate header until we find 'data' chunk
        self._buffer.extend(data)
        # minimal parser: look for 'data' chunk start; then emit everything after its 8-byte header
        buf = self._buffer
        if len(buf) < 44:
            return b''
        # Check RIFF/WAVE
        if not (buf[0:4] == b'RIFF' and buf[8:12] == b'WAVE'):
            # Not WAV; pass-through to avoid stalling
            self._need_header = False
            return bytes(buf)
        # Search for 'data' chunk from byte 12 onwards
        i = 12
        while i + 8 <= len(buf):
            chunk_id = buf[i:i+4]
            chunk_size = int.from_bytes(buf[i+4:i+8], 'little', signed=False)
            if chunk_id == b'data':
                start = i + 8
                self._need_header = False
                self._data_started = True
                out = bytes(buf[start:])
                # Clear buffer to avoid growth
                self._buffer = bytearray()
                return out
            # advance to next chunk
            i += 8 + chunk_size
            if i > len(buf) + 4096:
                # safety; don't spin
                break
        # header incomplete; wait for more bytes
        return b''


def main():
    # Logging setup
    log_dir = os.getcwd()
    log_path = os.path.join(log_dir, "ava_runtime.log")
    logger = logging.getLogger("ava")
    logger.setLevel(logging.DEBUG)
    if not logger.handlers:
        handler = RotatingFileHandler(log_path, maxBytes=512_000, backupCount=3, encoding="utf-8")
        fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(threadName)s %(message)s")
        handler.setFormatter(fmt)
        logger.addHandler(handler)
    logger.info("AVA starting up")
    # Load keys inside main so module import doesn't exit the interpreter
    if not os.path.exists("deepgram key.txt"):
        logger.error("Missing 'deepgram key.txt' in working directory: %s", os.getcwd())
        raise FileNotFoundError("Missing 'deepgram key.txt' in the working directory")
    with open("deepgram key.txt", "r") as f:
        deepgram_api_key = f.read().strip()

    # Optional: set GEMINI_API_KEY if present
    if os.path.exists("gemini api key.txt"):
        with open("gemini api key.txt", "r") as f:
            os.environ["GEMINI_API_KEY"] = f.read().strip()

    client = DeepgramClient(api_key=deepgram_api_key)
    logger.info("Deepgram client initialized")

    # Audio I/O
    p = pyaudio.PyAudio()
    speaker_stream = p.open(format=pyaudio.paInt16, channels=1, rate=24000, output=True)
    mic_stream = p.open(format=FORMAT, channels=CHANNELS, rate=RATE, input=True, frames_per_buffer=CHUNK)
    logger.info("Audio I/O opened: mic %d Hz chunk=%d, speaker %d Hz", RATE, CHUNK, 24000)

    # Shared connection reference for the mic thread
    connection_ref = {"conn": None}  # type: ignore[var-annotated]
    conn_lock = threading.Lock()

    # Barge-in and echo control state
    # - tts_active: agent is currently playing or streaming audio
    # - user_speaking: elevated mic energy detected consistently (debounced)
    # - barge_mode: while active, drop all TTS playback to enforce half-duplex during speech
    tts_active = threading.Event()
    user_speaking = threading.Event()
    barge_mode = threading.Event()
    last_user_voice_t = {"t": 0.0}
    # VAD thresholds (int16 RMS) and timers
    START_THRESH = 1600  # ~ -25 dBFS base floor
    STOP_THRESH = 900    # ~ -30 dBFS
    SPEECH_HOLD_SEC = 0.6
    QUIET_AFTER_BARGE = 0.3
    SPEECH_DEBOUNCE_FRAMES = 3
    # Track far-end (playback) RMS to distinguish leakage from true speech
    playback_rms = {"v": 0.0}
    playback_lock = threading.Lock()

    last_tx_time = {"t": 0.0}
    def microphone_thread():
        while not shutdown_event.is_set():
            try:
                in_data = mic_stream.read(CHUNK, exception_on_overflow=False)
            except Exception as ex:
                logger.warning("Mic read error: %s", ex)
                time.sleep(0.05)
                continue

            # Energy-based VAD + strict half-duplex gating to avoid echo
            rms = _rms_int16(in_data)
            now = time.time()
            # track consecutive loud frames to debounce speech start
            if not hasattr(microphone_thread, "_loud_frames"):
                microphone_thread._loud_frames = 0  # type: ignore[attr-defined]
            if tts_active.is_set():
                if not user_speaking.is_set():
                    # Dynamic threshold based on far-end playback level
                    with playback_lock:
                        prms = playback_rms["v"]
                    dyn_thresh = max(START_THRESH, prms * 0.6)
                    if rms >= dyn_thresh:
                        microphone_thread._loud_frames += 1  # type: ignore[attr-defined]
                        if microphone_thread._loud_frames >= SPEECH_DEBOUNCE_FRAMES:  # type: ignore[attr-defined]
                            user_speaking.set()
                            barge_mode.set()  # drop all TTS while user speaks
                            last_user_voice_t["t"] = now
                    else:
                        microphone_thread._loud_frames = 0  # type: ignore[attr-defined]
                else:
                    # Maintain speaking state with hysteresis and hold
                    if rms >= STOP_THRESH:
                        last_user_voice_t["t"] = now
                    elif (now - last_user_voice_t["t"]) > SPEECH_HOLD_SEC:
                        user_speaking.clear()
                # If TTS is active and user isn't speaking, drop mic frames to prevent echo entirely
                if not user_speaking.is_set():
                    # To keep connection alive, send periodic tiny silence frames while suppressing echo
                    if (now - last_tx_time["t"]) > 5.0:
                        silent = b"\x00" * CHUNK * 2  # 16-bit mono
                        if connection_active.is_set():
                            with conn_lock:
                                conn = connection_ref["conn"]
                            if conn is not None:
                                try:
                                    conn.send_media(silent)
                                    last_tx_time["t"] = now
                                except Exception as ex:
                                    logger.debug("Keepalive silent send failed: %s", ex)
                    continue
            else:
                # No TTS; reset state
                barge_mode.clear()
                user_speaking.clear()
                microphone_thread._loud_frames = 0  # type: ignore[attr-defined]

            # Send upstream only if we have a live connection
            if connection_active.is_set():
                with conn_lock:
                    conn = connection_ref["conn"]
                if conn is not None:
                    try:
                        conn.send_media(in_data)
                        last_tx_time["t"] = time.time()
                    except Exception as ex:
                        logger.debug("Mic frame send failed: %s", ex)
            else:
                time.sleep(0.01)

    mic_sender_thread = threading.Thread(target=microphone_thread, name="mic_sender", daemon=True)
    mic_sender_thread.start()

    # Strip WAV headers from agent audio
    wav_stripper = WavToPcmStripper()

    # Watchdog: force reconnect if idle for too long
    last_rx_time = {"t": time.time()}
    def watchdog_thread():
        IDLE_TIMEOUT = 25.0
        while not shutdown_event.is_set():
            time.sleep(5.0)
            if connection_active.is_set():
                now = time.time()
                idle_for = now - max(last_rx_time["t"], last_tx_time["t"])
                if idle_for > IDLE_TIMEOUT:
                    logger.warning("Watchdog: idle %.1fs, forcing reconnect", idle_for)
                    with conn_lock:
                        conn = connection_ref["conn"]
                    try:
                        if conn is not None:
                            conn.close()
                    except Exception as ex:
                        logger.debug("Watchdog close error: %s", ex)
                    connection_active.clear()
    threading.Thread(target=watchdog_thread, name="watchdog", daemon=True).start()

    backoff = 1.0
    try:
        while not shutdown_event.is_set():
            try:
                with client.agent.v1.connect() as connection:
                    logger.info("Created WebSocket connection")
                    with conn_lock:
                        connection_ref["conn"] = connection
                    connection_active.set()
                    backoff = 1.0  # reset backoff on success

                    def on_message(message: AgentV1SocketClientResponse):
                        nonlocal wav_stripper
                        if isinstance(message, bytes):
                            # We expect WAV container from server; strip header and write PCM
                            pcm = wav_stripper.feed(message)
                            if pcm:
                                tts_active.set()
                                # Update far-end playback RMS (EMA)
                                try:
                                    frame_rms = _rms_int16(pcm)
                                    with playback_lock:
                                        playback_rms["v"] = (playback_rms["v"] * 0.85) + (frame_rms * 0.15)
                                except Exception:
                                    pass
                                last_rx_time["t"] = time.time()
                                # If barge mode is active (user speaking), drop playback to prevent echo
                                if barge_mode.is_set():
                                    return
                                try:
                                    speaker_stream.write(pcm)
                                except Exception as ex:
                                    logger.debug("Speaker write failed: %s", ex)
                        else:
                            msg_type = getattr(message, "type", "Unknown")
                            if msg_type == "ConversationText":
                                # Text transcript of conversation turns
                                logger.info("ConversationText %s: %s", getattr(message, 'role', '?'), getattr(message, 'content', '?'))
                                last_rx_time["t"] = time.time()
                            elif msg_type == "AgentAudioDone":
                                # End of current TTS clip
                                tts_active.clear()
                                user_speaking.clear()
                                barge_mode.clear()
                                wav_stripper.reset()
                            else:
                                # Log any other structured messages for debugging
                                try:
                                    logger.debug("Message type=%s payload=%s", msg_type, message)
                                except Exception:
                                    logger.debug("Message type=%s (unprintable payload)", msg_type)

                    def on_close(close):
                        # Try to expose code/reason for debugging
                        try:
                            code = getattr(close, 'code', None)
                            reason = getattr(close, 'reason', None)
                            logger.warning("Connection Closed code=%s reason=%s raw=%s", code, reason, close)
                        except Exception:
                            logger.warning("Connection Closed (no detail): %s", close)
                        connection_active.clear()
                        with conn_lock:
                            connection_ref["conn"] = None

                    connection.on(EventType.MESSAGE, on_message)
                    connection.on(EventType.CLOSE, on_close)

                    # Settings: request WAV container (we strip locally) and set models
                    settings = AgentV1SettingsMessage(
                        audio=AgentV1AudioConfig(
                            input=AgentV1AudioInput(
                                encoding="linear16",
                                sample_rate=RATE,
                            ),
                            output=AgentV1AudioOutput(
                                encoding="linear16",
                                sample_rate=24000,
                                container="wav",
                            ),
                        ),
                        agent=AgentV1Agent(
                            language="en",
                            listen=AgentV1Listen(
                                provider=AgentV1ListenProvider(
                                    type="deepgram",
                                    model="nova-2",
                                )
                            ),
                            think=AgentV1Think(
                                provider=AgentV1GoogleThinkProvider(
                                    type="google",
                                    model="gemini-2.5-flash",
                                ),
                                prompt="You are a friendly AI assistant named AVA.",
                            ),
                            speak=AgentV1SpeakProviderConfig(
                                provider=AgentV1DeepgramSpeakProvider(
                                    type="deepgram",
                                    model="aura-2-andromeda-en",
                                )
                            ),
                        ),
                    )
                    connection.send_settings(settings)

                    connection.start_listening()
                    logger.info("Listening... Speak into your microphone.")

                    # Keep main thread alive while connection is active
                    while connection_active.is_set() and not shutdown_event.is_set():
                        time.sleep(0.1)

            except Exception as e:
                logger.error("Connection error: %s. Reconnecting in %.1fs...", e, backoff)
                connection_active.clear()
                with conn_lock:
                    connection_ref["conn"] = None
                time.sleep(backoff)
                backoff = min(backoff * 2.0, 30.0)

    finally:
        # --- Cleanup ---
        try:
            mic_stream.stop_stream(); mic_stream.close()
        except Exception as ex:
            logger.debug("Mic close error: %s", ex)
        try:
            speaker_stream.stop_stream(); speaker_stream.close()
        except Exception as ex:
            logger.debug("Speaker close error: %s", ex)
        try:
            p.terminate()
        except Exception as ex:
            logger.debug("PyAudio terminate error: %s", ex)


if __name__ == "__main__":
    os.chdir(sys.path[0])
    try:
        main()
    except KeyboardInterrupt:
            print("Interrupted by user. Shutting down gracefully.")
            shutdown_event.set()
    except Exception as e:
        print(f"An unhandled error occurred: {e}")
