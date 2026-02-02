// Enhanced voice hook with OpenAI Realtime API
import { useState, useCallback, useRef, useEffect } from 'react';

export function useRealtimeVoice() {
  const [isConnected, setIsConnected] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [vad, setVad] = useState('silent'); // 'silent' or 'speaking'
  
  const wsRef = useRef(null);
  const pcRef = useRef(null);
  const micRef = useRef(null);
  const audioRef = useRef(null);
  const vuRef = useRef(null);

  // VAD (Voice Activity Detection) for barge-in
  const startLocalVAD = useCallback((stream) => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const bins = new Uint8Array(analyser.fftSize);
    src.connect(analyser);

    let smooth = 0;
    const loop = () => {
      analyser.getByteTimeDomainData(bins);
      let sum = 0;
      for (let i = 0; i < bins.length; i++) {
        const d = (bins[i] - 128) / 128;
        sum += d * d;
      }
      const rms = Math.sqrt(sum / bins.length);
      smooth = 0.8 * smooth + 0.2 * rms;
      const pct = Math.min(100, Math.max(0, smooth * 6 * 100));
      if (vuRef.current) vuRef.current.style.width = pct.toFixed(0) + '%';
      const speaking = smooth > 0.05;
      setVad(speaking ? 'speaking' : 'silent');

      // Barge-in: pause model audio if user speaks
      if (speaking && isPlaying && audioRef.current && !audioRef.current.paused) {
        try {
          audioRef.current.pause();
          audioRef.current.currentTime = 0;
        } catch {}
        setIsPlaying(false);
      }
      requestAnimationFrame(loop);
    };
    loop();
  }, [isPlaying]);

  // Connect to OpenAI Realtime API via server proxy
  const connect = useCallback(async () => {
    if (isConnected) return;

    try {
      const serverUrl = import.meta.env.VITE_AVA_SERVER_URL || 'http://127.0.0.1:5051';
      const wsUrl = serverUrl.replace('http', 'ws') + '/realtime/ws';
      
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        // Configure session with female voice
        try {
          ws.send(JSON.stringify({
            type: 'session.update',
            session: {
              instructions: 'You are AVA, a helpful, concise assistant with a warm, natural voice.',
              voice: 'nova' // Female voice
            }
          }));
        } catch {}
      };

      ws.onmessage = (ev) => {
        try {
          const obj = JSON.parse(ev.data);
          
          if (obj.type === 'response.audio.delta' && obj.delta) {
            // Handle audio response
            if (audioRef.current) {
              const audioData = atob(obj.delta);
              const bytes = new Uint8Array(audioData.length);
              for (let i = 0; i < audioData.length; i++) {
                bytes[i] = audioData.charCodeAt(i);
              }
              // Play audio (simplified - in practice you'd need proper audio streaming)
              setIsPlaying(true);
            }
          } else if (obj.type === 'response.text.delta' && obj.delta) {
            // Handle text response
            setTranscript(prev => prev + obj.delta);
          } else if (obj.type === 'response.done') {
            setIsPlaying(false);
          }
        } catch (error) {
          console.error('WebSocket message error:', error);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      ws.onclose = () => {
        setIsConnected(false);
        setIsListening(false);
        setIsPlaying(false);
      };

    } catch (error) {
      console.error('Failed to connect to realtime API:', error);
    }
  }, [isConnected]);

  // Start microphone
  const startMic = useCallback(async () => {
    if (!isConnected || micRef.current) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      micRef.current = stream;
      const track = stream.getAudioTracks()[0];
      
      if (pcRef.current) {
        pcRef.current.addTrack(track, stream);
      }

      setIsListening(true);
      startLocalVAD(stream);
    } catch (error) {
      console.error('Failed to start microphone:', error);
    }
  }, [isConnected, startLocalVAD]);

  // Stop microphone
  const stopMic = useCallback(() => {
    if (micRef.current) {
      micRef.current.getTracks().forEach(track => track.stop());
      micRef.current = null;
    }
    setIsListening(false);
  }, []);

  // Send text message
  const sendMessage = useCallback((text) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !text.trim()) return;

    try {
      wsRef.current.send(JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['text', 'audio'],
          instructions: text
        }
      }));
      setTranscript('');
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  }, []);

  // Disconnect
  const disconnect = useCallback(() => {
    if (micRef.current) {
      micRef.current.getTracks().forEach(track => track.stop());
      micRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.getSenders().forEach(sender => {
        try {
          if (sender.track) sender.track.stop();
        } catch {}
      });
      pcRef.current.close();
      pcRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
    setIsListening(false);
    setIsPlaying(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    isConnected,
    isListening,
    isPlaying,
    transcript,
    vad,
    connect,
    disconnect,
    startMic,
    stopMic,
    sendMessage,
    audioRef,
    vuRef
  };
}