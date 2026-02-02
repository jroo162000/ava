# AVA Architecture Guidelines

## 🚫 PREVENT CODE DUPLICATION

### **DO NOT CREATE:**
- Multiple App components (`AppWS.jsx`, `AppChat.jsx`, etc.)
- Multiple Modern/Enhanced variants
- Duplicate message handling logic
- Redundant API hooks

### **USE INSTEAD:**
- **Single unified `AVA.jsx` component** with mode props
- **Feature flags** for optional functionality
- **Shared hooks** in `/hooks` directory
- **Configuration props** instead of new files

## Component Usage

```jsx
// ✅ CORRECT - Use unified component with modes
import AVA from './components/AVA.jsx'

// Simple chat only
<AVA mode="simple" enableVoice={false} enableHistory={false} />

// Voice enabled  
<AVA mode="voice" enableVoice={true} enableHistory={false} />

// Full featured
<AVA mode="enhanced" enableVoice={true} enableHistory={true} enableTools={true} />

// ❌ WRONG - Don't create new component files
import SimpleAVA from './SimpleAVA.jsx' // NO
import AppWS from './AppWS.jsx'         // NO  
import ModernAVA from './ModernAVA.jsx' // NO
```

## File Structure Rules

```
src/
├── components/
│   ├── AVA.jsx              ← SINGLE SOURCE OF TRUTH
│   ├── ErrorBoundary.jsx    ← Shared utilities only
│   └── (no other App/AVA variants)
├── hooks/
│   ├── useApi.js            ← Shared API logic
│   ├── useRealtimeVoice.js  ← Voice functionality
│   └── useMemory.js         ← Memory management
└── main.jsx                 ← Entry point
```

## Enforcement

1. **ESLint Rules**: `.eslintrc-ava.js` prevents importing legacy components
2. **Git Hooks**: Pre-commit checks for duplicate patterns
3. **Code Review**: Manual verification of architectural compliance

## Migration Path

When adding new features:
1. Add props to existing `AVA.jsx` component
2. Use feature flags for optional behavior  
3. Update mode configurations
4. **Never create new component files**

## Anti-Patterns to Avoid

- ❌ Creating `AVA2.jsx`, `NewAVA.jsx`, `BetterAVA.jsx`
- ❌ Copy-pasting message handling logic
- ❌ Duplicate WebSocket/API code
- ❌ Multiple entry points in `main.jsx`

## Emergency Break-Glass

If you absolutely must create a variant:
1. Document why in this file
2. Plan consolidation timeline  
3. Add TODO comments with removal date
4. Update safeguards to prevent similar issues