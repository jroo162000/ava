import React, { useState } from 'react'

export default function MinimalApp() {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState([
    { who: 'bot', text: 'AVA Web Interface Restored! Intelligent file search is ready.' }
  ])

  const sendMessage = async (message) => {
    if (!message.trim()) return
    
    // Add user message
    setMessages(prev => [...prev, { who: 'user', text: message }])
    setInput('')
    
    try {
      const response = await fetch('http://127.0.0.1:5051/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message })
      })
      
      const data = await response.json()
      if (data.status === 'success') {
        setMessages(prev => [...prev, { who: 'bot', text: data.message }])
      } else {
        setMessages(prev => [...prev, { who: 'bot', text: `Error: ${data.message}` }])
      }
    } catch (error) {
      setMessages(prev => [...prev, { who: 'bot', text: `Connection error: ${error.message}` }])
    }
  }

  return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      <h1>AVA - Intelligent Assistant</h1>
      <div style={{ 
        border: '1px solid #ccc', 
        height: '400px', 
        overflowY: 'auto', 
        padding: '10px', 
        marginBottom: '10px' 
      }}>
        {messages.map((msg, i) => (
          <div key={i} style={{ 
            marginBottom: '10px',
            padding: '8px',
            backgroundColor: msg.who === 'user' ? '#e3f2fd' : '#f5f5f5',
            borderRadius: '4px'
          }}>
            <strong>{msg.who === 'user' ? 'You' : 'AVA'}:</strong> {msg.text}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex' }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && sendMessage(input)}
          placeholder="Ask AVA to open a file, search for something, or help with tasks..."
          style={{ 
            flex: 1, 
            padding: '8px', 
            marginRight: '10px',
            border: '1px solid #ccc',
            borderRadius: '4px'
          }}
        />
        <button 
          onClick={() => sendMessage(input)}
          style={{ 
            padding: '8px 16px',
            backgroundColor: '#2196f3',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer'
          }}
        >
          Send
        </button>
      </div>
      <p style={{ marginTop: '10px', fontSize: '12px', color: '#666' }}>
        Try: "open my resume", "find python files", "show me the readme", etc.
      </p>
    </div>
  )
}