# AVA - Autonomous Virtual Assistant

AVA is a comprehensive AI-powered virtual assistant system with a modular architecture consisting of three main components:

## 🏗️ Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   ava-client    │◄────┤   ava-server     │◄────┤ ava-integration │
│   (Frontend)    │     │   (Backend API)  │     │  (AI Services)  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

### Components

#### 1. ava-client (Frontend)
- **Technology**: React + Vite + Electron
- **Location**: `ava-client/`
- **Features**:
  - Modern React-based UI
  - Real-time voice interaction
  - WebSocket communication
  - Cross-platform desktop app (Electron)
  - Chat history and session management

#### 2. ava-server (Backend API)
- **Technology**: Node.js + Express
- **Location**: `ava-server/`
- **Features**:
  - RESTful API
  - WebSocket server for real-time communication
  - Session management and tracking
  - Agent loop for autonomous operations
  - Memory management
  - Tool execution framework
  - Security middleware

#### 3. ava-integration (AI Services)
- **Technology**: Python
- **Location**: `ava-integration/`
- **Features**:
  - AI bridge for LLM integration
  - Voice recognition and synthesis (Piper TTS, Vosk STT)
  - Real-time voice chat
  - Self-awareness and personality modules
  - Passive learning system
  - Tool definitions and execution
  - Health monitoring

## 🚀 Quick Start

### Prerequisites
- Node.js (v18+)
- Python (v3.9+)
- npm or yarn

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/ava.git
   cd ava
   ```

2. **Set up the Client**
   ```bash
   cd ava-client
   npm install
   npm run dev
   ```

3. **Set up the Server**
   ```bash
   cd ../ava-server
   npm install
   npm start
   ```

4. **Set up the Integration**
   ```bash
   cd ../ava-integration
   python -m venv .venv
   .venv\Scripts\activate  # Windows
   # source .venv/bin/activate  # Mac/Linux
   pip install -r requirements.txt
   python ava_standalone_realtime.py
   ```

## 📁 Project Structure

```
ava/
├── ava-client/          # Frontend application
│   ├── src/
│   │   ├── components/  # React components
│   │   ├── hooks/       # Custom React hooks
│   │   └── styles/      # CSS styles
│   └── public/
├── ava-server/          # Backend API server
│   ├── src/
│   │   ├── routes/      # API routes
│   │   ├── services/    # Business logic
│   │   ├── middleware/  # Express middleware
│   │   └── utils/       # Utility functions
│   └── tests/
└── ava-integration/     # Python AI services
    ├── memory/          # Memory storage
    ├── tests/           # Python tests
    └── vendor/          # Third-party binaries
```

## 🔧 Configuration

### Environment Variables

Each component has its own `.env` file:

- `ava-client/.env` - Frontend configuration
- `ava-server/.env` - Backend configuration
- `ava-integration/.env` - AI services configuration

See `.env.example` files in each component for required variables.

## 🧪 Testing

```bash
# Client tests
cd ava-client
npm test

# Server tests
cd ava-server
npm test

# Integration tests
cd ava-integration
pytest
```

## 📝 Documentation

Each component has its own documentation:

- [ava-client/README.md](ava-client/README.md)
- [ava-server/README.md](ava-server/README.md)
- [ava-integration/ALWAYS_ON_AVA.md](ava-integration/ALWAYS_ON_AVA.md)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## 📄 License

This project is proprietary and confidential.

## 👥 Authors

- AVA Development Team

---

Built with ❤️ using React, Node.js, Python, and AI.
