// Enhanced AVA with CMP-Use Integration + Chat History
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAVABridge } from '../hooks/useApi.js';
import ErrorBoundary from './ErrorBoundary.jsx';
import '../ChatHistory.css';

const EnhancedAVA = () => {
  const [messages, setMessages] = useState([{
    id: 1,
    type: 'bot',
    text: "Hello! I'm AVA, your enhanced AI assistant with voice capabilities and intelligent tool integration. How can I help you today?",
    timestamp: new Date().toISOString()
  }]);
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  
  // Chat History State
  const [showHistory, setShowHistory] = useState(false);
  const [chatHistory, setChatHistory] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  
  const bridge = useAVABridge();

  const addMessage = useCallback((message) => {
    setMessages(prev => [...prev, {
      id: Date.now() + Math.random(),
      timestamp: new Date().toISOString(),
      ...message
    }]);
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(scrollToBottom, [messages]);
  
  // Load chat history on component mount
  useEffect(() => {
    loadChatHistory();
  }, []);
  
  // Voice input handling - integrate with chat API
  const handleVoiceInput = useCallback(async (transcript) => {
    if (!transcript.trim()) return;
    
    // Add voice input message to chat
    addMessage({
      type: 'user',
      text: `🎤 ${transcript}`,
      isVoiceInput: true
    });
    
    // Process through regular chat API
    await handleSendMessage(transcript);
  }, [addMessage, handleSendMessage]);

  // Auto-start voice recognition - no button required
  useEffect(() => {
    const startVoiceAutomatically = async () => {
      try {
        if (!isListening) {
          const response = await bridge.startVoice();
          if (response.status === 'success') {
            setIsListening(true);
            addMessage({
              type: 'system',
              text: "🎙️ Voice recognition active. Say 'AVA' followed by your command."
            });
          }
        }
      } catch (error) {
        console.error('Auto voice start error:', error);
        // Don't show error to user, just silently fail
      }
    };

    // Start voice automatically after a short delay
    const timer = setTimeout(startVoiceAutomatically, 1000);
    return () => clearTimeout(timer);
  }, [bridge, isListening, addMessage]);

  // Load chat history from AVA Bridge
  const loadChatHistory = async () => {
    try {
      const response = await fetch('http://127.0.0.1:5051/api/history');
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
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    
    try {
      const response = await fetch('http://127.0.0.1:5051/api/history/search', {
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

  // Create new chat session
  const createNewSession = async () => {
    try {
      const response = await fetch('http://127.0.0.1:5051/api/session/new', {
        method: 'POST'
      });
      const data = await response.json();
      if (data.status === 'success') {
        setCurrentSessionId(data.session_id);
        setMessages([{
          id: 1,
          type: 'bot',
          text: "New chat session started. How can I help you today?",
          timestamp: new Date().toISOString()
        }]);
        loadChatHistory(); // Refresh history
      }
    } catch (e) {
      console.error('Failed to create new session:', e);
      addMessage({ type: 'bot', text: 'Error creating new session' });
    }
  };

  // Load specific chat session
  const loadChatSession = (session) => {
    setCurrentSessionId(session.id);
    setMessages([]);
    session.messages.forEach((msg, index) => {
      if (msg.user) {
        addMessage({ type: 'user', text: msg.user });
      }
      if (msg.ava) {
        addMessage({ type: 'bot', text: msg.ava });
      }
    });
  };

  const handleSendMessage = useCallback(async (text) => {
    if (!text.trim()) return;

    // Add user message
    addMessage({ type: 'user', text });
    setInput('');
    setIsTyping(true);

    try {
      // Send to AVA Bridge for intelligent processing
      const response = await bridge.sendMessage(text);
      
      if (response.status === 'success') {
        // Add bot response
        addMessage({ 
          type: 'bot', 
          text: response.message,
          toolResults: response.tool_results,
          responseType: response.type
        });
        
        // Speak the response if it's available
        if (response.message && typeof response.message === 'string') {
          try {
            await bridge.speak(response.message);
          } catch (speakError) {
            console.warn('TTS failed:', speakError);
          }
        }
        
        // Update current session ID and refresh history
        if (response.session_id) {
          setCurrentSessionId(response.session_id);
        }
        loadChatHistory();
      } else {
        throw new Error(response.message || 'Unknown error');
      }
    } catch (error) {
      console.error('Error sending message:', error);
      addMessage({
        type: 'bot',
        text: `I apologize, but I encountered an error: ${error.message}. Please try again.`,
        error: true
      });
    } finally {
      setIsTyping(false);
    }
  }, [bridge, addMessage]);

  const handleVoiceToggle = useCallback(async () => {
    try {
      if (isListening) {
        await bridge.stopVoice();
        setIsListening(false);
      } else {
        const response = await bridge.startVoice();
        if (response.status === 'success') {
          setIsListening(true);
          addMessage({
            type: 'system',
            text: "🎙️ Voice recognition started. Say 'AVA' followed by your command."
          });
        } else {
          throw new Error(response.message);
        }
      }
    } catch (error) {
      console.error('Voice toggle error:', error);
      addMessage({
        type: 'system',
        text: `Voice error: ${error.message}`,
        error: true
      });
    }
  }, [bridge, isListening, addMessage]);

  const handleKeyPress = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage(input);
    }
  }, [input, handleSendMessage]);

  const renderMessage = (message) => {
    const isBot = message.type === 'bot';
    const isSystem = message.type === 'system';
    
    return (
      <div
        key={message.id}
        className={`message-container ${isBot ? 'bot' : isSystem ? 'system' : 'user'}`}
      >
        <div className={`message ${isBot ? 'bot-message' : isSystem ? 'system-message' : 'user-message'}`}>
          {isBot && (
            <div className="message-header">
              <div className="bot-avatar">🤖</div>
              <span className="bot-name">AVA</span>
              {message.responseType && (
                <span className="response-type">{message.responseType}</span>
              )}
            </div>
          )}
          
          <div className="message-content">
            {message.text}
            
            {message.toolResults && (
              <div className="tool-results">
                <h4>🔧 Tool Results:</h4>
                {Array.isArray(message.toolResults) ? (
                  message.toolResults.map((result, idx) => (
                    <div key={idx} className="tool-result">
                      <strong>{result.tool}:</strong> {result.output}
                    </div>
                  ))
                ) : (
                  <pre>{JSON.stringify(message.toolResults, null, 2)}</pre>
                )}
              </div>
            )}
          </div>
          
          <div className="message-time">
            {new Date(message.timestamp).toLocaleTimeString()}
          </div>
        </div>
      </div>
    );
  };

  return (
    <ErrorBoundary>
      <div className="ava-container">
        <div className={`main-content ${showHistory ? 'with-sidebar' : ''}`}>
          {/* Chat History Sidebar */}
          {showHistory && (
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
                          onClick={() => loadChatSession(session)}
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

          {/* Main Chat Area */}
          <div className="ava-chat-area">
            <div className="ava-header">
              <div className="ava-title">
                <div className="ava-logo">🤖</div>
                <div>
                  <h1>AVA Enhanced</h1>
                  <p>AI Assistant with Voice & Tool Integration</p>
                </div>
              </div>
              
              <div className="ava-controls">
                <button onClick={() => setShowHistory(!showHistory)}>
                  {showHistory ? 'Hide History' : 'Show History'}
                </button>
                
                <button onClick={createNewSession}>
                  New Chat
                </button>
                
                {/* Voice is now automatically active - no button needed */}
                {isListening && (
                  <div className="voice-indicator">
                    🎙️ Listening for "AVA"
                  </div>
                )}
                
                <div className="connection-status">
                  {bridge.error ? (
                    <span className="status error">❌ Disconnected</span>
                  ) : (
                    <span className="status connected">✅ Connected</span>
                  )}
                </div>
              </div>
            </div>

            <div className="messages-container">
              {messages.map(renderMessage)}
              
              {isTyping && (
                <div className="message-container bot">
                  <div className="message bot-message">
                    <div className="message-header">
                      <div className="bot-avatar">🤖</div>
                      <span className="bot-name">AVA</span>
                    </div>
                    <div className="typing-indicator">
                      <div className="typing-text">🧠 AVA is thinking...</div>
                      <div className="typing-dots">
                        <span></span>
                        <span></span>
                        <span></span>
                      </div>
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
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="Type your message or use voice commands..."
                  disabled={bridge.loading}
                  rows={1}
                  style={{
                    minHeight: '24px',
                    maxHeight: '120px',
                    resize: 'none',
                    overflow: 'auto'
                  }}
                />
                
                <button
                  onClick={() => handleSendMessage(input)}
                  disabled={!input.trim() || bridge.loading}
                  className="send-btn"
                >
                  {bridge.loading ? '⏳' : '➤'}
                </button>
              </div>
              
              {bridge.error && (
                <div className="error-message">
                  ⚠️ {bridge.error.message}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
};

export default EnhancedAVA;