// Simple test component to check if React is working
import React from 'react';

const TestComponent = () => {
  return (
    <div style={{
      padding: '20px',
      backgroundColor: '#f0f0f0',
      color: '#333',
      fontFamily: 'Inter, sans-serif',
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center'
    }}>
      <h1>AVA Test Component</h1>
      <p>If you can see this, React is working!</p>
      <div style={{
        backgroundColor: 'white',
        padding: '15px',
        borderRadius: '8px',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
        marginTop: '20px'
      }}>
        <p>Server should be running on: http://localhost:5051</p>
        <p>Current time: {new Date().toLocaleString()}</p>
      </div>
    </div>
  );
};

export default TestComponent;