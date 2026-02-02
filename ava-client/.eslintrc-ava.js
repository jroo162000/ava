// ESLint rules to prevent AVA code duplication
module.exports = {
  rules: {
    // Prevent multiple App component exports in same directory
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['./App*.jsx', './src/App*.jsx'],
            message: 'Use the unified AVA component instead of legacy App components'
          },
          {
            group: ['./components/ModernAVA*.jsx', './src/components/ModernAVA*.jsx'],
            message: 'Use the unified AVA component instead of ModernAVA variants'
          },
          {
            group: ['./components/EnhancedAVA*.jsx', './src/components/EnhancedAVA*.jsx'], 
            message: 'Use the unified AVA component instead of EnhancedAVA variants'
          },
          {
            group: ['./SimpleAVA.jsx', './src/SimpleAVA.jsx'],
            message: 'Use the unified AVA component instead of SimpleAVA'
          }
        ]
      }
    ],
    
    // Prevent duplicate function definitions
    'no-duplicate-functions': 'error',
    
    // Encourage single source of truth
    'prefer-single-export': 'warn'
  }
};