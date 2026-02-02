// Unified AVA Component - Consolidates all functionality into one configurable interface
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useChat, useMemory } from '../hooks/useApi.js';
import { useRealtimeVoice } from '../hooks/useRealtimeVoice.js';
import ErrorBoundary from './ErrorBoundary.jsx';

const AVA = ({ 
  mode = 'enhanced', // 'simple' | 'voice' | 'enhanced' | 'chat'
  enableVoice = true,
  enableHistory = true,
  enableTools = false,
  serverUrl = null 
}) => {
  // Core state
  const [messages, setMessages] = useState([{
    id: 1,
    type: 'bot',
    text: 'Hello! I\'m AVA, your ambient voice assistant. How can I help you today?',
    timestamp: Date.now()
  }]);
  const [inputText, setInputText] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [writeMode, setWriteMode] = useState('unknown');
  const [persona, setPersona] = useState(null);
  const [sidebarTab, setSidebarTab] = useState('memory');
  const [showHistory, setShowHistory] = useState(enableHistory);
  const [chatHistory, setChatHistory] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [currentSessionId, setCurrentSessionId] = useState(null);

  // Refs
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const sessionId = useRef(`session-${Date.now()}`);

  // API hooks
  const chat = useChat();
  const memory = useMemory();
  const voice = useRealtimeVoice();

  // Get base URL
  const getBaseURL = useCallback(() => {
    if (serverUrl) return serverUrl.replace(/\/$/, '');
    try {
      const ls = localStorage.getItem('AVA_SERVER_URL');
      if (ls) return ls.replace(/\/$/, '');
    } catch {}
    return (import.meta.env.VITE_AVA_SERVER_URL || 'http://127.0.0.1:5051').replace(/\/$/, '');
  }, [serverUrl]);

  // Auto-scroll to bottom
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Load initial data
  useEffect(() => {
    const loadInitialData = async () => {
      const baseUrl = getBaseURL();
      
      try {
        // Health check
        const healthCheck = await fetch(`${baseUrl}/debug`);
        if (healthCheck.ok) {
          const data = await healthCheck.json();
          setIsConnected(true);
          setWriteMode(data.allowWrite ? 'on' : 'off');
        }
      } catch (err) {
        console.error('Health check failed:', err);
        setIsConnected(false);
      }

      // Load persona if memory enabled
      if (enableHistory) {
        try {
          const personaData = await memory.getPersona();
          if (personaData.ok) {
            setPersona(personaData.persona);
          }
        } catch (error) {
          console.error('Failed to load persona:', error);
        }
      }
      
      // Connect voice if enabled
      if (enableVoice) {
        voice.connect();
      }

      // Load chat history if enabled
      if (enableHistory) {
        loadChatHistory();
      }
    };

    loadInitialData();
  }, [enableVoice, enableHistory, memory, voice, getBaseURL]);

  // Handle voice transcript
  useEffect(() => {
    if (enableVoice && voice.transcript) {
      addMessage('bot', voice.transcript);
    }
  }, [voice.transcript, enableVoice]);

  // Load chat history
  const loadChatHistory = async () => {
    if (!enableHistory) return;
    
    try {
      const response = await fetch(`${getBaseURL()}/api/history`);
      const data = await response.json();
      if (data.status === 'success') {
        setChatHistory(data.sessions || []);
      }
    } catch (e) {
      console.error('Failed to load chat history:', e);
    }
  };

  // Search chat history
  const searchHistory = async (query) => {
    if (!enableHistory || !query.trim()) {
      setSearchResults([]);
      return;
    }
    
    try {
      const response = await fetch(`${getBaseURL()}/api/history/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      const data = await response.json();
      if (data.status === 'success') {
        setSearchResults(data.results || []);
      }
    } catch (e) {
      console.error('Failed to search history:', e);
    }
  };

  // Add message helper
  const addMessage = useCallback((type, text, extra = {}) => {
    const message = {
      id: Date.now() + Math.random(),
      type,
      text,
      timestamp: Date.now(),
      ...extra
    };
    setMessages(prev => [...prev, message]);
    return message;
  }, []);

  // Send message handler
  const handleSendMessage = async (text = inputText) => {
    if (!text?.trim()) return;
    
    addMessage('user', text);
    setInputText('');

    try {
      if (mode === 'voice' && enableVoice) {
        // Use voice API
        voice.sendMessage(text);
      } else {
        // Use chat API
        const baseUrl = getBaseURL();
        const response = await fetch(`${baseUrl}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, session_id: sessionId.current })
        });
        
        const data = await response.json();
        if (data.ok) {
          addMessage('bot', data.text);
          if (enableHistory) {
            loadChatHistory();
          }
        } else {
          addMessage('bot', 'Sorry, I encountered an error. Please try again.', { error: true });
        }
      }
    } catch (error) {
      console.error('Send message error:', error);
      addMessage('bot', `Error: ${error.message}`, { error: true });
    }
  };

  // Voice controls
  const handleVoiceToggle = () => {
    if (!enableVoice) return;
    
    if (voice.isListening) {
      voice.stopMic();
    } else {
      voice.startMic();
    }
  };

  // Keyboard handler
  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Create new session
  const createNewSession = async () => {
    if (!enableHistory) return;
    
    try {
      const response = await fetch(`${getBaseURL()}/api/session/new`, {
        method: 'POST'
      });
      const data = await response.json();
      if (data.status === 'success') {
        setCurrentSessionId(data.session_id);
        setMessages([{
          id: 1,
          type: 'bot',
          text: "New chat session started. How can I help you today?",
          timestamp: Date.now()
        }]);
        loadChatHistory();
      }
    } catch (e) {
      console.error('Failed to create new session:', e);
    }
  };

  // Message renderer
  const renderMessage = (message) => (
    <div key={message.id} className={`message ${message.type}`}>
      <div className="message-avatar">
        {message.type === 'user' ? 'U' : 'AVA'}
      </div>
      <div className="message-content">
        <div className="message-text">{message.text}</div>
        <div className="message-time">
          {new Date(message.timestamp).toLocaleTimeString()}
        </div>
        {message.error && (
          <div className="message-error-indicator">⚠️ Error</div>
        )}
      </div>
    </div>
  );

  // Sidebar content renderer
  const renderSidebarContent = () => {
    if (!enableHistory && !enableTools) return null;

    switch (sidebarTab) {
      case 'memory':
        return (
          <div>
            <h3 className="sidebar-title">Memory & Context</h3>
            {persona ? (
              <div className="memory-panel">
                <div className="memory-title">Personal Info</div>
                <div className="memory-item">Name: {persona.name}</div>
                {persona.facts.map((fact, index) => (
                  <div key={index} className="memory-item">{fact}</div>
                ))}
              </div>
            ) : (
              <div className="memory-panel">
                <div className="memory-title">No persona loaded</div>
              </div>
            )}
          </div>
        );
      
      case 'settings':
        return (
          <div>
            <h3 className="sidebar-title">Settings</h3>
            <div className="settings-section">
              <div className="setting-item">
                <label>
                  Voice Recognition: {enableVoice && voice.isConnected ? '✅ Available' : '❌ Disabled'}
                </label>
              </div>
              <div className="setting-item">
                <label>
                  Write Mode: {writeMode === 'on' ? '✅ Enabled' : '❌ Read Only'}
                </label>
              </div>
              <div className="setting-item">
                <label>
                  Connection: {isConnected ? '✅ Online' : '❌ Offline'}
                </label>
              </div>
            </div>
          </div>
        );
      
      default:
        return null;
    }
  };

  // Render based on mode
  const renderInterface = () => {
    // Simple mode - minimal interface
    if (mode === 'simple') {
      return (
        <div style={{
          maxWidth: '800px',
          margin: '0 auto',
          padding: '20px',
          fontFamily: 'Arial, sans-serif'
        }}>
          <div style={{
            backgroundColor: '#f5f5f5',
            borderRadius: '10px',
            padding: '20px',
            marginBottom: '20px'
          }}>
            <h1 style={{ margin: '0 0 10px 0', color: '#333' }}>🤖 AVA - AI Assistant</h1>
            <p style={{ margin: 0, color: '#666' }}>Unified Interface</p>
          </div>

          <div style={{
            height: '400px',
            border: '1px solid #ddd',
            borderRadius: '8px',
            padding: '15px',
            overflowY: 'auto',
            backgroundColor: 'white',
            marginBottom: '15px'
          }}>
            {messages.map(msg => (
              <div key={msg.id} style={{
                marginBottom: '15px',
                padding: '10px',
                borderRadius: '8px',
                backgroundColor: msg.type === 'user' ? '#e3f2fd' : '#f5f5f5',
                textAlign: msg.type === 'user' ? 'right' : 'left'
              }}>
                <div style={{ fontWeight: 'bold', marginBottom: '5px' }}>
                  {msg.type === 'user' ? '👤 You' : '🤖 AVA'}
                </div>
                <div>{msg.text}</div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Type your message here..."
              style={{
                flex: 1,
                padding: '12px',
                border: '1px solid #ddd',
                borderRadius: '6px',
                fontSize: '14px'
              }}
            />
            <button
              onClick={() => handleSendMessage()}
              disabled={!inputText.trim()}
              style={{
                padding: '12px 20px',
                backgroundColor: '#2196f3',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '14px'
              }}
            >
              Send
            </button>
          </div>
        </div>
      );
    }

    // Enhanced mode - full interface
    return (
      <div className="app">
        {/* Header */}
        <header className="header">
          <div className="header-content">
            <div className="logo">
              <div className="logo-icon">AVA</div>
              <div className="logo-text">Ambient Voice Assistant</div>
            </div>
            
            <div className="status-indicators">
              <div className={`status-badge ${isConnected ? 'online' : 'offline'}`}>
                <div className="status-dot"></div>
                {isConnected ? 'Online' : 'Offline'}
              </div>
              
              {writeMode === 'on' && (
                <div className="status-badge write-enabled">
                  Write Enabled
                </div>
              )}
              
              {enableVoice && voice.isConnected && (
                <div className={`status-badge ${voice.isListening ? 'listening' : 'idle'}`}>
                  🎤 Voice {voice.isListening ? 'Listening' : 'Ready'}
                </div>
              )}

              {enableHistory && (
                <button onClick={() => setShowHistory(!showHistory)}>
                  {showHistory ? 'Hide History' : 'Show History'}
                </button>
              )}

              {enableHistory && (
                <button onClick={createNewSession}>
                  New Chat
                </button>
              )}
            </div>
          </div>
        </header>

        {/* Main content */}
        <main className="main">
          <div style={{ display: 'flex', gap: '1.5rem', flex: 1 }}>
            {/* Chat History Sidebar */}
            {enableHistory && showHistory && (
              <div className="chat-sidebar">
                <div className="sidebar-header">
                  <h3>Chat History</h3>
                  <div className="search-box">
                    <input
                      type="text"
                      placeholder="Search conversations..."
                      value={searchQuery}
                      onChange={(e) => {
                        setSearchQuery(e.target.value);
                        searchHistory(e.target.value);
                      }}
                    />
                  </div>
                </div>
                
                <div className="sidebar-content">
                  {searchResults.length > 0 ? (
                    <div className="search-results">
                      <h4>Search Results ({searchResults.length})</h4>
                      {searchResults.map((result, i) => (
                        <div key={i} className="search-result">
                          <div className="result-timestamp">
                            {new Date(result.timestamp).toLocaleDateString()}
                          </div>
                          <div className="result-user">{result.user_message}</div>
                          <div className="result-ava">{result.ava_response.substring(0, 100)}...</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="chat-sessions">
                      {chatHistory.length === 0 ? (
                        <div className="no-history">No chat history yet</div>
                      ) : (
                        chatHistory.map((session) => (
                          <div 
                            key={session.id} 
                            className={`session-item ${currentSessionId === session.id ? 'active' : ''}`}
                          >
                            <div className="session-date">{session.date}</div>
                            <div className="session-preview">{session.preview}</div>
                            <div className="session-count">{session.messages.length} messages</div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Chat area */}
            <div className="chat-container">
              <div className="messages">
                {messages.map(renderMessage)}
                {chat.loading && (
                  <div className="message bot">
                    <div className="message-avatar">AVA</div>
                    <div className="message-content">
                      <div className="loading">
                        <div className="spinner"></div>
                        Thinking...
                      </div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
              
              <div className="input-container">
                <div className="input-wrapper">
                  <textarea
                    ref={inputRef}
                    className="input-field"
                    placeholder="Type your message or use voice..."
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyPress={handleKeyPress}
                    rows="1"
                    style={{
                      resize: 'none',
                      overflow: 'hidden',
                      minHeight: '44px'
                    }}
                  />
                  
                  <div className="voice-controls">
                    {enableVoice && voice.isConnected && (
                      <button
                        className={`btn btn-round microphone-button ${voice.isListening ? 'listening' : ''}`}
                        onClick={handleVoiceToggle}
                        title={voice.isListening ? 'Stop listening' : 'Start voice input'}
                      >
                        🎤
                      </button>
                    )}
                    
                    <button
                      className="btn btn-primary"
                      onClick={() => handleSendMessage()}
                      disabled={!inputText.trim() || chat.loading}
                    >
                      Send
                    </button>
                  </div>
                </div>
                
                {enableVoice && voice.isListening && (
                  <div className="voice-indicator listening">
                    <div className="status-dot"></div>
                    Listening... Speak now
                  </div>
                )}
              </div>
            </div>

            {/* Settings Sidebar */}
            {(enableHistory || enableTools) && (
              <aside className="sidebar">
                <div className="sidebar-header">
                  <div style={{ display: 'flex', gap: '1rem' }}>
                    {enableHistory && (
                      <button 
                        className={`btn ${sidebarTab === 'memory' ? 'btn-primary' : 'btn-ghost'}`}
                        onClick={() => setSidebarTab('memory')}
                      >
                        Memory
                      </button>
                    )}
                    <button 
                      className={`btn ${sidebarTab === 'settings' ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => setSidebarTab('settings')}
                    >
                      Settings
                    </button>
                  </div>
                </div>
                
                <div className="sidebar-content">
                  {renderSidebarContent()}
                </div>
              </aside>
            )}
          </div>
        </main>
      </div>
    );
  };

  return (
    <ErrorBoundary>
      {renderInterface()}
    </ErrorBoundary>
  );
};

export default AVA;