import React from 'react'
import { createRoot } from 'react-dom/client'
import AVAEnhanced from './MinimalAVA.jsx'
import ArtifactPanel from './components/ArtifactPanel.jsx'

// PRIMARY AVA UI - Enhanced version locked as main interface
// This UI is tested and working with natural language processing.
// ArtifactPanel is a self-contained fixed-position overlay (visual reference popup); it renders
// nothing until AVA pushes an artifact, so it can't affect the existing UI when idle.
createRoot(document.getElementById('root')).render(
  <React.Fragment>
    <AVAEnhanced />
    <ArtifactPanel />
  </React.Fragment>
)
