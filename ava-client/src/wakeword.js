// Wake word detector factory with optional Porcupine integration.

export async function createWakeWordDetector(options = {}){
  let running = false
  let onWake = options.onWake || (()=>{})
  let impl = null

  // Try dynamic Porcupine integration if a global or module is available.
  try {
    const mod = await import('./wakeword-porcupine.js').catch(()=>null)
    if (mod && typeof mod.createPorcupineDetector === 'function') {
      impl = await mod.createPorcupineDetector({ onWake })
    }
  } catch {}

  return {
    async start(){
      running = true
      if (impl && typeof impl.start === 'function') return impl.start()
      // Fallback: no-op stub
    },
    async stop(){ running = false; if (impl && typeof impl.stop === 'function') return impl.stop() },
    setOnWake(fn){ onWake = fn; if (impl && typeof impl.setOnWake === 'function') impl.setOnWake(fn) },
    isRunning(){ return running }
  }
}

export default { createWakeWordDetector }
