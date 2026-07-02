import React from 'react'
import { createRoot } from 'react-dom/client'
import AVAEnhanced from './MinimalAVA.jsx'
import ArtifactPanel from './components/ArtifactPanel.jsx'
import Stage from './components/Stage.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'

// PRIMARY AVA UI — the Stage (Tier 3 #16, docs/UI_MERGE_PLAN.md): a presence, not a chat log.
// ?classic=1 renders the proven MinimalAVA chat view instead — the permanent escape hatch
// (see PRIMARY_UI.md history of white-screen incidents with complex UIs). The Stage is also
// wrapped in the ErrorBoundary so a render crash shows a recover link, never a white screen.
// ArtifactPanel: in classic mode it's mounted here; the Stage mounts its own copy.
const classic = new URLSearchParams(location.search).get('classic') === '1'
createRoot(document.getElementById('root')).render(
  classic ? (
    <React.Fragment>
      <AVAEnhanced />
      <ArtifactPanel />
    </React.Fragment>
  ) : (
    <ErrorBoundary>
      <Stage />
    </ErrorBoundary>
  )
)
