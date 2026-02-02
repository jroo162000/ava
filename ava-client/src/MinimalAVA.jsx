import React, { useState } from 'react';

const MinimalAVA = () => {
  const [messages, setMessages] = useState([{
    id: 1,
    type: 'bot',
    text: 'Hello! I\'m AVA, your enhanced assistant. This is the working enhanced UI!',
    timestamp: Date.now()
  }]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);

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

      const response = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: inputText,
          session_id: 'enhanced-client'
        })
      });

      const data = await response.json();

      const botMessage = {
        id: Date.now() + 1,
        type: 'bot',
        text: data.message || data.text || 'Sorry, I couldn\'t process that.',
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

  // React 19: onKeyPress is deprecated; use onKeyDown
  const handleKeyDown = (e) => {
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
      {/* Enhanced Header */}
      <div style={{
        padding: '1rem 2rem',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        color: 'white',
        boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
      }}>
        <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: '600' }}>
          AVA - Enhanced Assistant
        </h1>
        <p style={{ margin: '0.5rem 0 0 0', opacity: 0.9, fontSize: '0.875rem' }}>
          ✅ Enhanced UI Connected • Natural Language Ready • Server Connected
        </p>
      </div>

      {/* Messages */}
      <div style={{
        flex: 1,
        padding: '1.5rem',
        overflowY: 'auto',
        maxHeight: 'calc(100vh - 200px)'
      }}>
        {messages.map((message) => (
          <div
            key={message.id}
            style={{
              marginBottom: '1.5rem',
              display: 'flex',
              justifyContent: message.type === 'user' ? 'flex-end' : 'flex-start'
            }}
          >
            <div
              style={{
                maxWidth: '70%',
                padding: '1rem 1.25rem',
                borderRadius: message.type === 'user' ? '1.5rem 1.5rem 0.25rem 1.5rem' : '1.5rem 1.5rem 1.5rem 0.25rem',
                background: message.type === 'user'
                  ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
                  : 'white',
                color: message.type === 'user' ? 'white' : '#1f2937',
                boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                fontSize: '0.925rem',
                lineHeight: '1.6'
              }}
            >
              {(() => {
                // If bot says Created XYZ: C:\path, show a clickable download link
                if (message.type === 'bot') {
                  const m = String(message.text||'')
                  const match = m.match(/Created\s+([A-Z]+):\s+(.+)$/)
                  if (match) {
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
              <div style={{
                fontSize: '0.75rem',
                opacity: 0.7,
                marginTop: '0.5rem'
              }}>
                {new Date(message.timestamp).toLocaleTimeString()}
              </div>
            </div>
          </div>
        ))}
        {isLoading && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '1rem' }}>
            <div style={{
              padding: '1rem 1.25rem',
              borderRadius: '1.5rem 1.5rem 1.5rem 0.25rem',
              backgroundColor: 'white',
              boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
              fontSize: '0.925rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}>
              <div style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: '#667eea',
                animation: 'pulse 1.5s ease-in-out infinite'
              }}></div>
              AVA is thinking...
            </div>
          </div>
        )}
      </div>

      {/* Enhanced Input */}
      <div style={{
        padding: '1.5rem',
        backgroundColor: 'white',
        borderTop: '1px solid #e5e7eb',
        boxShadow: '0 -4px 6px rgba(0,0,0,0.05)'
      }}>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Try: 'read the readme', 'list files', 'what can you do'..."
            disabled={isLoading}
            style={{
              flex: 1,
              padding: '0.875rem 1.25rem',
              border: '2px solid #e5e7eb',
              borderRadius: '1rem',
              fontSize: '0.925rem',
              outline: 'none',
              backgroundColor: isLoading ? '#f3f4f6' : 'white',
              transition: 'border-color 0.2s',
              fontFamily: 'inherit'
            }}
            onFocus={(e) => e.target.style.borderColor = '#667eea'}
            onBlur={(e) => e.target.style.borderColor = '#e5e7eb'}
          />
          <button
            onClick={sendMessage}
            disabled={isLoading || !inputText.trim()}
            style={{
              padding: '0.875rem 1.5rem',
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              color: 'white',
              border: 'none',
              borderRadius: '1rem',
              fontSize: '0.925rem',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              opacity: isLoading ? 0.6 : 1,
              fontWeight: '500',
              transition: 'opacity 0.2s'
            }}
          >
            {isLoading ? 'Sending...' : 'Send'}
          </button>
        </div>
        <div style={{
          marginTop: '0.75rem',
          fontSize: '0.75rem',
          color: '#6b7280',
          textAlign: 'center'
        }}>
          Enhanced UI with Natural Language Understanding • Try: "read the changelog", "list files"
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
};

export default MinimalAVA;
