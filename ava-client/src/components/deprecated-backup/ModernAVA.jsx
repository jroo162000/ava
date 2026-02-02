// Modern AVA Interface with enhanced features
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useChat, useMemory, useTools } from '../hooks/useApi.js';
import { useVoice } from '../hooks/useVoice.js';
import ErrorBoundary from './ErrorBoundary.jsx';

const ModernAVA = () => {
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
  const [tools, setTools] = useState([]);
  const [sidebarTab, setSidebarTab] = useState('tools'); // 'tools', 'memory', 'settings'

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const sessionId = useRef(`session-${Date.now()}`);

  // API hooks
  const chat = useChat();
  const memory = useMemory();
  const toolsApi = useTools();
  
  // Voice hooks
  const voice = useVoice();

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
      try {
        // Check connection and write mode
        const healthCheck = await fetch(`${import.meta.env.VITE_AVA_SERVER_URL || 'http://127.0.0.1:5051'}/debug`);
        if (healthCheck.ok) {
          const data = await healthCheck.json();
          setIsConnected(true);
          setWriteMode(data.allowWrite ? 'on' : 'off');
        }
      } catch (error) {
        console.error('Health check failed:', error);
        setIsConnected(false);
      }

      // Load persona
      try {
        const personaData = await memory.getPersona();
        if (personaData.ok) {
          setPersona(personaData.persona);
        }
      } catch (error) {
        console.error('Failed to load persona:', error);
      }

      // Load tools
      try {
        const toolsData = await toolsApi.getTools();
        if (toolsData.ok && toolsData.tools) {
          setTools(toolsData.tools);
        }
      } catch (error) {
        console.error('Failed to load tools:', error);
      }
    };

    loadInitialData();
  }, [memory, toolsApi]);

  // Handle voice transcript
  useEffect(() => {
    if (voice.transcript && !voice.isListening) {
      setInputText(voice.transcript);
      // Auto-send after voice input
      setTimeout(() => {
        if (voice.transcript.trim()) {
          handleSendMessage(voice.transcript);
        }
      }, 500);
    }
  }, [voice.transcript, voice.isListening]);

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

  const handleSendMessage = async (text = inputText) => {
    if (!text?.trim()) return;
    
    const userMessage = addMessage('user', text);
    setInputText('');

    try {
      const response = await chat.sendMessage(text, sessionId.current);
      
      if (response.ok) {
        const botMessage = addMessage('bot', response.text, {
          usage: response.usage
        });
        
        // Auto-speak response if voice is enabled
        if (voice.isSupported && !voice.isPlaying) {
          voice.speak(response.text);
        }
      } else {
        addMessage('bot', 'Sorry, I encountered an error. Please try again.', {
          error: true
        });
      }
    } catch (error) {
      console.error('Chat error:', error);
      addMessage('bot', `Error: ${error.message}`, {
        error: true
      });
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleVoiceToggle = () => {
    if (voice.isListening) {
      voice.stopListening();
    } else {
      voice.startListening();
    }
  };

  const handleToolClick = async (tool) => {
    const toolMessage = `Use the ${tool.name} tool`;
    addMessage('user', toolMessage, { tool: true });
    
    try {
      const response = await chat.sendMessage(toolMessage, sessionId.current);
      if (response.ok) {
        addMessage('bot', response.text, { tool: tool.name });
      }
    } catch (error) {
      addMessage('bot', `Failed to use ${tool.name}: ${error.message}`, { error: true });
    }
  };

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
        {message.tool && (
          <div className="message-tool-indicator">🔧 {message.tool}</div>
        )}
      </div>
    </div>
  );

  const renderSidebarContent = () => {
    switch (sidebarTab) {
      case 'tools':
        return (
          <div>
            <h3 className="sidebar-title">Available Tools</h3>
            {toolsApi.loading ? (
              <div className="loading">
                <div className="spinner"></div>
                Loading tools...
              </div>
            ) : (
              <div className="tool-grid">
                {tools.map((tool, index) => (
                  <div 
                    key={index}
                    className="tool-card"
                    onClick={() => handleToolClick(tool)}
                  >
                    <div className="tool-icon">🔧</div>
                    <div className="tool-name">{tool.name}</div>
                    <div className="tool-description">{tool.description}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      
      case 'memory':
        return (
          <div>
            <h3 className="sidebar-title">Memory & Context</h3>
            {persona && (
              <div className="memory-panel">
                <div className="memory-title">Personal Info</div>
                <div className="memory-item">Name: {persona.name}</div>
                {persona.facts.map((fact, index) => (
                  <div key={index} className="memory-item">{fact}</div>
                ))}
              </div>
            )}
          </div>
        );
      
      case 'settings':
        return (
          <div>
            <h3 className="sidebar-title">Settings</h3>
            <div className="settings-section">
              <label>
                <input 
                  type="checkbox" 
                  checked={voice.isSupported} 
                  disabled 
                />
                Voice Recognition {voice.isSupported ? '✅' : '❌'}
              </label>
            </div>
          </div>
        );
      
      default:
        return null;
    }
  };

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
            
            {voice.isSupported && (
              <div className={`status-badge ${voice.isListening ? 'listening' : 'idle'}`}>
                🎤 Voice {voice.isListening ? 'Listening' : 'Ready'}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="main">
        <div style={{ display: 'flex', gap: '1.5rem', flex: 1 }}>
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
                  {voice.isSupported && (
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
              
              {voice.isListening && (
                <div className="voice-indicator listening">
                  <div className="status-dot"></div>
                  Listening... Speak now
                </div>
              )}
              
              {voice.isPlaying && (
                <div className="voice-indicator speaking">
                  <div className="status-dot"></div>
                  Speaking...
                </div>
              )}
            </div>
          </div>

          {/* Sidebar */}
          <aside className="sidebar">
            <div className="sidebar-header">
              <div style={{ display: 'flex', gap: '1rem' }}>
                <button 
                  className={`btn ${sidebarTab === 'tools' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setSidebarTab('tools')}
                >
                  Tools
                </button>
                <button 
                  className={`btn ${sidebarTab === 'memory' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setSidebarTab('memory')}
                >
                  Memory
                </button>
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
        </div>
      </main>
    </div>
  );
};

// Wrap with error boundary
const ModernAVAWithErrorBoundary = () => (
  <ErrorBoundary>
    <ModernAVA />
  </ErrorBoundary>
);

export default ModernAVAWithErrorBoundary;