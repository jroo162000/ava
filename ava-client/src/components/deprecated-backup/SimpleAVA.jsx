import React, { useState, useEffect } from 'react';

export default function SimpleAVA() {
  const [messages, setMessages] = useState([
    { id: 1, type: 'bot', text: 'Hello! I am AVA. How can I help you today?' }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const addMessage = (type, text) => {
    setMessages(prev => [...prev, {
      id: Date.now(),
      type,
      text,
      timestamp: new Date().toLocaleTimeString()
    }]);
  };

  const sendMessage = async () => {
    if (!input.trim()) return;
    
    addMessage('user', input);
    setInput('');
    setIsLoading(true);

    try {
      const response = await fetch('http://127.0.0.1:5051/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: input })
      });
      
      if (response.ok) {
        const data = await response.json();
        addMessage('bot', data.message || 'Response received');
      } else {
        addMessage('bot', 'Sorry, I encountered an error. Please try again.');
      }
    } catch (error) {
      addMessage('bot', 'Connection error. Please check if the AVA bridge is running.');
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
        <h1 style={{ margin: '0 0 10px 0', color: '#333' }}>🤖 AVA - Modern AI Assistant</h1>
        <p style={{ margin: 0, color: '#666' }}>Enhanced with CMP-Use Integration</p>
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
            {msg.timestamp && (
              <div style={{ fontSize: '12px', color: '#888', marginTop: '5px' }}>
                {msg.timestamp}
              </div>
            )}
          </div>
        ))}
        {isLoading && (
          <div style={{
            padding: '10px',
            borderRadius: '8px',
            backgroundColor: '#f5f5f5',
            fontStyle: 'italic',
            color: '#666'
          }}>
            🤔 AVA is thinking...
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '10px' }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder="Type your message here..."
          disabled={isLoading}
          style={{
            flex: 1,
            padding: '12px',
            border: '1px solid #ddd',
            borderRadius: '6px',
            fontSize: '14px'
          }}
        />
        <button
          onClick={sendMessage}
          disabled={!input.trim() || isLoading}
          style={{
            padding: '12px 20px',
            backgroundColor: '#2196f3',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: isLoading ? 'not-allowed' : 'pointer',
            fontSize: '14px'
          }}
        >
          {isLoading ? '⏳' : 'Send'}
        </button>
      </div>

      <div style={{
        marginTop: '15px',
        padding: '10px',
        backgroundColor: '#e8f5e8',
        borderRadius: '6px',
        fontSize: '12px',
        color: '#2e7d32'
      }}>
        ✅ Connected to AVA Bridge (Port 5051) • Enhanced file search enabled
      </div>
    </div>
  );
}