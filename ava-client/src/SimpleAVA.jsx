// Simple AVA Interface - Basic React without complex hooks
import React, { useState, useRef } from 'react';

const SimpleAVA = () => {
  const [messages, setMessages] = useState([{
    id: 1,
    type: 'bot',
    text: 'Hello! I\'m AVA, your voice assistant. Chat is working!',
    timestamp: Date.now()
  }]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef(null);

  const sendMessage = async () => {
    if (!inputText.trim()) return;

    const userMessage = {
      id: Date.now(),
      type: 'user',
      text: inputText,
      timestamp: Date.now()
    };

    setMessages(prev => [...prev, userMessage]);
    setInputText('');
    setIsLoading(true);

    try {
      const API_BASE = (import.meta?.env?.VITE_AVA_SERVER_URL || '/api').replace(/\/$/, '')

      // Intercept document creation intents and call deterministic endpoint
      const lower = inputText.toLowerCase()
      const fmtMatch = lower.match(/\b(pdf|docx|xlsx|pptx|rtf|txt|md|csv|json|html)\b/)
      if (/(create|generate|make|write).*\b(pdf|docx|xlsx|pptx|rtf|txt|md|csv|json|html)\b/.test(lower)) {
        const fmt = (fmtMatch ? fmtMatch[1] : 'txt').toLowerCase()
        const dir = /documents?/.test(lower) ? 'documents' : 'downloads'
        const content = /random/.test(lower)
          ? `Random message ${Math.random().toString(36).slice(2,8)} from AVA.`
          : inputText
        const respDoc = await fetch(`${API_BASE}/tools/file_gen`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ format: fmt, content, dir })
        })
        const docData = await respDoc.json().catch(()=>({}))
        const botText = docData?.ok
          ? `Created ${fmt.toUpperCase()}: ${docData.path || 'file created'}`
          : (docData?.text || docData?.error || 'Could not create the document.')
        const botMessage = { id: Date.now() + 1, type: 'bot', text: botText, timestamp: Date.now() }
        setMessages(prev => [...prev, botMessage])
        return
      }

      const response = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: inputText,
          session_id: 'web-client'
        })
      });

      const data = await response.json();

      const botMessage = {
        id: Date.now() + 1,
        type: 'bot',
        text: data.text || 'Sorry, I couldn\'t process that.',
        timestamp: Date.now()
      };

      setMessages(prev => [...prev, botMessage]);
    } catch (error) {
      const errorMessage = {
        id: Date.now() + 1,
        type: 'bot',
        text: `Error: ${error.message}`,
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'Inter, system-ui, sans-serif',
      backgroundColor: '#f8fafc'
    }}>
      {/* Header */}
      <div style={{
        padding: '1rem 2rem',
        backgroundColor: '#6366f1',
        color: 'white',
        boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
      }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>AVA - Voice Assistant</h1>
        <p style={{ margin: '0.25rem 0 0 0', opacity: 0.9, fontSize: '0.875rem' }}>
          Connected to server • All tools available
        </p>
      </div>

      {/* Messages */}
      <div style={{
        flex: 1,
        padding: '1rem',
        overflowY: 'auto',
        maxHeight: 'calc(100vh - 200px)'
      }}>
        {messages.map((message) => (
          <div
            key={message.id}
            style={{
              marginBottom: '1rem',
              display: 'flex',
              justifyContent: message.type === 'user' ? 'flex-end' : 'flex-start'
            }}
          >
            <div
              style={{
                maxWidth: '70%',
                padding: '0.75rem 1rem',
                borderRadius: '1rem',
                backgroundColor: message.type === 'user' ? '#6366f1' : 'white',
                color: message.type === 'user' ? 'white' : '#1f2937',
                boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
                fontSize: '0.875rem',
                lineHeight: '1.5'
              }}
            >
              {(() => {
                if (message.type === 'bot'){
                  const m = String(message.text||'')
                  const match = m.match(/Created\s+([A-Z]+):\s+(.+)$/)
                  if (match){
                    const fmt = match[1]
                    const pathText = match[2]
                    const API_BASE = (import.meta?.env?.VITE_AVA_SERVER_URL || '/api').replace(/\/$/, '')
                    const href = `${API_BASE}/files/download?p=${encodeURIComponent(pathText)}`
                    return (
                      <span>
                        {`Created ${fmt}: `}
                        <a href={href} target="_blank" rel="noopener noreferrer">{pathText}</a>
                      </span>
                    )
                  }
                }
                return message.text
              })()}
            </div>
          </div>
        ))}
        {isLoading && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '1rem' }}>
            <div style={{
              padding: '0.75rem 1rem',
              borderRadius: '1rem',
              backgroundColor: 'white',
              boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
              fontSize: '0.875rem'
            }}>
              Thinking...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: '1rem',
        backgroundColor: 'white',
        borderTop: '1px solid #e5e7eb',
        boxShadow: '0 -1px 3px rgba(0,0,0,0.1)'
      }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Ask me anything... (try 'what can you do' or 'system info')"
            disabled={isLoading}
            style={{
              flex: 1,
              padding: '0.75rem 1rem',
              border: '1px solid #d1d5db',
              borderRadius: '0.5rem',
              fontSize: '0.875rem',
              outline: 'none',
              backgroundColor: isLoading ? '#f3f4f6' : 'white'
            }}
          />
          <button
            onClick={sendMessage}
            disabled={isLoading || !inputText.trim()}
            style={{
              padding: '0.75rem 1.5rem',
              backgroundColor: '#6366f1',
              color: 'white',
              border: 'none',
              borderRadius: '0.5rem',
              fontSize: '0.875rem',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              opacity: isLoading ? 0.6 : 1
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
};

export default SimpleAVA;
