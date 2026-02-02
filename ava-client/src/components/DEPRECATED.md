# ⚠️ DEPRECATED COMPONENTS

The following components have been **DEPRECATED** and consolidated into the unified `AVA.jsx` component:

## Removed Files:
- ❌ `AppWS.jsx` - WebSocket realtime version
- ❌ `AppWSClean.jsx` - Clean WebSocket version  
- ❌ `AppChat.jsx` - Chat-only version
- ❌ `SimpleAVA.jsx` - Basic chat version
- ❌ `ModernAVA.jsx` - Full-featured modern interface
- ❌ `ModernAVASimple.jsx` - Simplified modern interface
- ❌ `EnhancedAVA.jsx` - CMP-Use integration interface

## Migration Guide:

### Before (Multiple Components):
```jsx
// OLD - Don't use these anymore
import SimpleAVA from './SimpleAVA.jsx'
import AppWS from './AppWS.jsx'
import ModernAVA from './ModernAVA.jsx'
import EnhancedAVA from './EnhancedAVA.jsx'
```

### After (Unified Component):
```jsx
// NEW - Use this instead
import AVA from './AVA.jsx'

// Simple mode (replaces SimpleAVA)
<AVA mode="simple" enableVoice={false} enableHistory={false} />

// Voice mode (replaces AppWS)
<AVA mode="voice" enableVoice={true} enableHistory={false} />

// Enhanced mode (replaces EnhancedAVA)
<AVA mode="enhanced" enableVoice={true} enableHistory={true} enableTools={false} />

// Chat mode (replaces AppChat)
<AVA mode="chat" enableVoice={false} enableHistory={true} />
```

## Why Consolidated?

1. **Reduced Bundle Size**: Single component vs 7 separate files
2. **Easier Maintenance**: One source of truth for all features
3. **Consistent Behavior**: Shared logic and state management
4. **Better Performance**: Conditional rendering vs separate components
5. **Prevent Future Duplication**: Architectural safeguards in place

## Removal Timeline:

- ✅ **Phase 1** (Completed): Created unified component
- ✅ **Phase 2** (Completed): Updated entry points
- 🔄 **Phase 3** (In Progress): Remove deprecated files
- ⏳ **Phase 4** (Pending): Update documentation

---

**❓ Questions?** Check `ARCHITECTURE.md` for the new component structure guidelines.