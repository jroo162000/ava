// Enhanced API hook with retry logic and error handling
import { useState, useCallback, useRef } from 'react';

const API_BASE = import.meta.env.VITE_AVA_SERVER_URL || 'http://127.0.0.1:5051';
const BRIDGE_API = 'http://127.0.0.1:5051';
const TIMEOUT = parseInt(import.meta.env.VITE_API_TIMEOUT) || 120000;
console.log('API Timeout set to:', TIMEOUT, 'ms');
const MAX_RETRIES = parseInt(import.meta.env.VITE_RETRY_ATTEMPTS) || 3;

class ApiError extends Error {
  constructor(message, status, response) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.response = response;
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function apiRequest(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);
  
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      throw new ApiError(
        errorData?.error || `HTTP ${response.status}`,
        response.status,
        errorData
      );
    }
    
    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error.name === 'AbortError') {
      throw new ApiError('Request timeout', 408);
    }
    
    throw error;
  }
}

async function apiRequestWithRetry(endpoint, options = {}, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await apiRequest(endpoint, options);
    } catch (error) {
      const isLastAttempt = attempt === retries;
      const shouldRetry = error.status >= 500 || error.name === 'ApiError' && error.status === 408;
      
      if (isLastAttempt || !shouldRetry) {
        throw error;
      }
      
      // Exponential backoff
      const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
      await sleep(delay);
    }
  }
}

export function useApi() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const abortController = useRef(null);

  const request = useCallback(async (endpoint, options = {}) => {
    // Abort previous request if still running
    if (abortController.current) {
      abortController.current.abort();
    }
    
    abortController.current = new AbortController();
    setLoading(true);
    setError(null);
    
    try {
      const data = await apiRequestWithRetry(endpoint, {
        ...options,
        signal: abortController.current.signal
      });
      
      return data;
    } catch (err) {
      if (err.name === 'AbortError') {
        return null; // Request was cancelled
      }
      
      setError(err);
      throw err;
    } finally {
      setLoading(false);
      abortController.current = null;
    }
  }, []);

  const get = useCallback((endpoint, options = {}) => {
    return request(endpoint, { method: 'GET', ...options });
  }, [request]);

  const post = useCallback((endpoint, data, options = {}) => {
    return request(endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
      ...options
    });
  }, [request]);

  const cancel = useCallback(() => {
    if (abortController.current) {
      abortController.current.abort();
    }
  }, []);

  return {
    loading,
    error,
    request,
    get,
    post,
    cancel
  };
}

// Specific API hooks
export function useChat() {
  const api = useApi();
  
  const sendMessage = useCallback(async (text, sessionId = 'default') => {
    return api.post('/chat', { text, sessionId });
  }, [api]);
  
  const respondToMessage = useCallback(async (messages, sessionId = 'default') => {
    return api.post('/respond', { messages, sessionId });
  }, [api]);
  
  return {
    ...api,
    sendMessage,
    respondToMessage
  };
}

export function useMemory() {
  const api = useApi();
  
  const searchMemory = useCallback(async (query, k = 5) => {
    return api.post('/memory/search', { query, k });
  }, [api]);
  
  const upsertMemory = useCallback(async (item) => {
    return api.post('/memory/upsert', item);
  }, [api]);
  
  const getPersona = useCallback(async () => {
    return api.get('/persona');
  }, [api]);
  
  return {
    ...api,
    searchMemory,
    upsertMemory,
    getPersona
  };
}

export function useTools() {
  const api = useApi();
  
  const getTools = useCallback(async () => {
    return api.get('/ava/tools');
  }, [api]);
  
  return {
    ...api,
    getTools
  };
}

// AVA Bridge API hooks for enhanced CMP-Use integration
async function bridgeRequest(endpoint, options = {}) {
  const url = `${BRIDGE_API}${endpoint}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);
  
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      throw new ApiError(
        errorData?.message || `HTTP ${response.status}`,
        response.status,
        errorData
      );
    }
    
    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error.name === 'AbortError') {
      throw new ApiError('Request timeout', 408);
    }
    
    throw error;
  }
}

export function useAVABridge() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const bridgeCall = useCallback(async (endpoint, options = {}) => {
    setLoading(true);
    setError(null);
    
    try {
      const data = await bridgeRequest(endpoint, options);
      return data;
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const sendMessage = useCallback(async (message) => {
    return bridgeCall('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message })
    });
  }, [bridgeCall]);

  const startVoice = useCallback(async () => {
    return bridgeCall('/api/voice/start', { method: 'POST' });
  }, [bridgeCall]);

  const stopVoice = useCallback(async () => {
    return bridgeCall('/api/voice/stop', { method: 'POST' });
  }, [bridgeCall]);

  const speak = useCallback(async (text) => {
    return bridgeCall('/api/speak', {
      method: 'POST',
      body: JSON.stringify({ text })
    });
  }, [bridgeCall]);

  const getTools = useCallback(async () => {
    return bridgeCall('/api/tools');
  }, [bridgeCall]);

  return {
    loading,
    error,
    sendMessage,
    startVoice,
    stopVoice,
    speak,
    getTools
  };
}