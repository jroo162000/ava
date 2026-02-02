// Optional Porcupine integration (placeholder). This module tries to use a globally provided
// Porcupine Web SDK if present. It is safe to import even when not available.

export async function createPorcupineDetector({ onWake = ()=>{} } = {}){
  let running = false
  // Expect a global creator e.g., window.PorcupineFactory or similar injected by the app.
  // Without it, this will act as a no-op.
  const hasGlobal = typeof window !== 'undefined' && (window.Porcupine || window.PorcupineWeb || window.PorcupineFactory)

  return {
    async start(){
      running = true
      if (!hasGlobal) return
      // TODO: initialize Porcupine with an "Ava" keyword model and mic stream.
      // When keyword is detected, call onWake().
      // This placeholder avoids throwing when SDK is not present.
    },
    async stop(){ running = false },
    setOnWake(fn){ onWake = fn },
    isRunning(){ return running }
  }
}

export default { createPorcupineDetector }

