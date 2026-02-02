#!/usr/bin/env node
// Anti-duplication checker for AVA components

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const PROHIBITED_PATTERNS = [
  /App[A-Z].*\.jsx$/,
  /ModernAVA[A-Z].*\.jsx$/,
  /EnhancedAVA[A-Z].*\.jsx$/,
  /SimpleAVA[A-Z].*\.jsx$/,
  /AVA[0-9].*\.jsx$/,
  /NewAVA.*\.jsx$/,
  /BetterAVA.*\.jsx$/
];

const PROHIBITED_CONTENT = [
  'export default function App',
  'function App(',
  'const App =',
  'export { App'
];

function scanDirectory(dir, violations = []) {
  const items = fs.readdirSync(dir);
  
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules' && item !== 'deprecated-backup') {
      scanDirectory(fullPath, violations);
    } else if (stat.isFile()) {
      // Check filename patterns
      for (const pattern of PROHIBITED_PATTERNS) {
        if (pattern.test(item)) {
          violations.push({
            type: 'prohibited_filename',
            file: path.relative(projectRoot, fullPath),
            pattern: pattern.source
          });
        }
      }
      
      // Check file content for prohibited exports
      if (item.endsWith('.jsx') || item.endsWith('.tsx')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          
          for (const prohibition of PROHIBITED_CONTENT) {
            if (content.includes(prohibition)) {
              violations.push({
                type: 'prohibited_content',
                file: path.relative(projectRoot, fullPath),
                content: prohibition
              });
            }
          }
        } catch (error) {
          // Skip files that can't be read
        }
      }
    }
  }
  
  return violations;
}

function main() {
  console.log('🔍 Checking for AVA component duplication...');
  
  const violations = scanDirectory(path.join(projectRoot, 'src'));
  
  if (violations.length === 0) {
    console.log('✅ No duplicate AVA components found!');
    process.exit(0);
  }
  
  console.log('❌ Found potential duplications:');
  console.log('');
  
  for (const violation of violations) {
    if (violation.type === 'prohibited_filename') {
      console.log(`📁 ${violation.file}`);
      console.log(`   Matches prohibited pattern: ${violation.pattern}`);
      console.log('   → Use unified AVA.jsx instead');
    } else if (violation.type === 'prohibited_content') {
      console.log(`📄 ${violation.file}`);
      console.log(`   Contains: ${violation.content}`);
      console.log('   → Export from AVA.jsx instead');
    }
    console.log('');
  }
  
  console.log('🏗️  Architecture Guidelines:');
  console.log('   • Use single AVA.jsx with mode props');
  console.log('   • Add features via configuration, not new files'); 
  console.log('   • See ARCHITECTURE.md for details');
  console.log('');
  
  process.exit(1);
}

main();