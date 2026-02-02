// WebSocket hook for real-time communication
import { useState, useEffect, useRef, useCallback } from 'react';

const WS_BASE = (import.meta.env.VITE_AVA_SERVER_URL || 'http://127.0.0.1:5051').replace('http', 'ws');

export function useWebSocket(options = {}) {
  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState('disconnected');
  const [lastMessage, setLastMessage] = useState(null);
  const [error, setError] = useState(null);
  
  const ws = useRef(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef(null);
  const messageQueue = useRef([]);
  const messageHandlers = useRef(new Map());
  
  const {
    autoConnect = true,
    reconnectInterval = 3000,
    maxReconnectAttempts = 5,
    heartbeatInterval = 30000,
    onOpen,
    onClose,
    onMessage,
    onError
  } = options;

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.CONNECTING || 
        ws.current?.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      setConnectionState('connecting');
      setError(null);
      
      ws.current = new WebSocket(WS_BASE);
      
      ws.current.onopen = (event) => {
        setIsConnected(true);
        setConnectionState('connected');
        reconnectAttempts.current = 0;
        
        // Send queued messages
        while (messageQueue.current.length > 0) {
          const message = messageQueue.current.shift();
          if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(message);
          }
        }
        
        onOpen?.(event);
      };
      
      ws.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setLastMessage(data);
          
          // Handle specific message types
          const handler = messageHandlers.current.get(data.type);
          if (handler) {
            handler(data);
          }
          
          onMessage?.(data, event);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };
      
      ws.current.onclose = (event) => {
        setIsConnected(false);
        setConnectionState('disconnected');
        
        // Attempt to reconnect if not intentional
        if (!event.wasClean && reconnectAttempts.current < maxReconnectAttempts) {
          setConnectionState('reconnecting');
          reconnectTimer.current = setTimeout(() => {
            reconnectAttempts.current++;
            connect();
          }, reconnectInterval);
        }
        
        onClose?.(event);
      };
      
      ws.current.onerror = (event) => {
        const errorMsg = 'WebSocket connection error';
        setError(errorMsg);
        setConnectionState('error');
        onError?.(event);
      };
      
    } catch (error) {
      setError(error.message);
      setConnectionState('error');
    }
  }, [WS_BASE, maxReconnectAttempts, reconnectInterval, onOpen, onClose, onMessage, onError]);

  // Disconnect from WebSocket
  const disconnect = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    
    if (ws.current) {
      ws.current.close(1000, 'Intentional disconnect');
      ws.current = null;
    }
    
    setIsConnected(false);
    setConnectionState('disconnected');
  }, []);

  // Send message
  const sendMessage = useCallback((message) => {
    const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
    
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(messageStr);
    } else {
      // Queue message if not connected
      messageQueue.current.push(messageStr);
      
      // Try to connect if not already connecting
      if (connectionState === 'disconnected') {
        connect();
      }
    }
  }, [connectionState, connect]);

  // Register message handler for specific message type
  const onMessageType = useCallback((type, handler) => {
    messageHandlers.current.set(type, handler);
    
    // Return cleanup function
    return () => {
      messageHandlers.current.delete(type);
    };
  }, []);

  // Send ping
  const ping = useCallback(() => {
    sendMessage({ type: 'ping', timestamp: Date.now() });
  }, [sendMessage]);

  // Auto-connect on mount
  useEffect(() => {
    if (autoConnect) {
      connect();
    }
    
    return () => {
      disconnect();
    };
  }, [autoConnect, connect, disconnect]);

  // Heartbeat
  useEffect(() => {
    if (!isConnected || !heartbeatInterval) return;
    
    const interval = setInterval(ping, heartbeatInterval);
    return () => clearInterval(interval);
  }, [isConnected, heartbeatInterval, ping]);

  return {
    isConnected,
    connectionState,
    lastMessage,
    error,
    connect,
    disconnect,
    sendMessage,
    onMessageType,
    ping
  };
}

// Specialized hook for AVA realtime features
export function useAVAWebSocket() {
  const [realtimeSession, setRealtimeSession] = useState(null);
  const [isAudioStreaming, setIsAudioStreaming] = useState(false);
  
  const ws = useWebSocket({
    onMessage: (data) => {
      switch (data.type) {
        case 'welcome':
          console.log('Connected to AVA server:', data.clientId);
          break;
        case 'realtime_session':
          setRealtimeSession(data.session);
          break;
        case 'audio_start':
          setIsAudioStreaming(true);
          break;
        case 'audio_end':
          setIsAudioStreaming(false);
          break;
      }
    }
  });

  const startRealtimeSession = useCallback(() => {
    ws.sendMessage({
      type: 'start_realtime',
      timestamp: Date.now()
    });
  }, [ws]);

  const endRealtimeSession = useCallback(() => {
    ws.sendMessage({
      type: 'end_realtime',
      timestamp: Date.now()
    });
    setRealtimeSession(null);
    setIsAudioStreaming(false);
  }, [ws]);

  const sendAudio = useCallback((audioData) => {
    if (realtimeSession) {
      ws.sendMessage({
        type: 'audio',
        data: audioData,
        sessionId: realtimeSession.id,
        timestamp: Date.now()
      });
    }
  }, [ws, realtimeSession]);

  return {
    ...ws,
    realtimeSession,
    isAudioStreaming,
    startRealtimeSession,
    endRealtimeSession,
    sendAudio
  };
}