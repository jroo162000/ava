// Memory Service - Phase 5: Memory as State
// Just-in-time memory injection for agent decisions
// Schema: text, type, priority, created_at, last_used_at, source, tags

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../utils/config.js';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const VECTORS_PATH = path.join(DATA_DIR, 'vectors.jsonl');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Memory types for categorization
 */
const MemoryType = {
  PREFERENCE: 'preference',      // User preferences (e.g., "prefers dark mode")
  FACT: 'fact',                  // Factual information (e.g., "user's name is Jelani")
  WORKFLOW: 'workflow',          // Learned workflows (e.g., "to deploy, run npm build first")
  CONSTRAINT: 'constraint',      // Constraints/rules (e.g., "never delete without confirmation")
  WARNING: 'warning',            // Warnings from past mistakes
  CONVERSATION: 'conversation',  // Conversation context
  AGENT_ACTION: 'agent_action',  // Agent execution history
  CREDENTIAL_HINT: 'credential_hint', // Non-sensitive credential hints
  SYSTEM: 'system'               // System-generated memories
};

/**
 * Memory sources
 */
const MemorySource = {
  USER: 'user',           // Explicitly stated by user
  LEARNED: 'learned',     // Inferred from behavior
  SYSTEM: 'system',       // System-generated
  CORRECTION: 'correction' // Learned from user corrections
};

// Simple hashed bag-of-words embedding
const D = 256;
const stop = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'of', 'on', 'in', 'to',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'i', 'you', 'he', 'she', 'it', 'we',
  'they', 'me', 'my', 'your', 'our', 'their', 'this', 'that', 'these', 'those', 'with',
  'as', 'at', 'by', 'from', 'about', 'into', 'over', 'after', 'before', 'so', 'not'
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word && !stop.has(word));
}

function hash(string) {
  let h = 2166136261;
  for (let i = 0; i < string.length; i++) {
    h ^= string.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function embedLocal(text) {
  const vector = new Float32Array(D);
  
  for (const word of tokenize(text)) {
    vector[hash(word) % D] += 1;
  }
  
  let sum = 0;
  for (let i = 0; i < D; i++) {
    sum += vector[i] * vector[i];
  }
  const norm = Math.sqrt(sum) || 1;
  
  for (let i = 0; i < D; i++) {
    vector[i] /= norm;
  }
  
  return Array.from(vector);
}

async function embedExternal(text) {
  if (!config.OPENAI_API_KEY) {
    return embedLocal(text);
  }
  
  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.EMBED_MODEL || 'text-embedding-3-small',
        input: String(text || '')
      })
    });
    
    const json = await response.json();
    const embedding = json?.data?.[0]?.embedding;
    
    if (Array.isArray(embedding)) {
      return embedding;
    }
  } catch (error) {
    logger.error('External embedding failed', { error: error.message });
  }
  
  return embedLocal(text);
}

function cosine(a, b) {
  let sum = 0;
  const minLength = Math.min(a.length, b.length);
  
  for (let i = 0; i < minLength; i++) {
    sum += a[i] * b[i];
  }
  
  return sum;
}

class MemoryService {
  constructor() {
    this.memory = [];
    this.sqlite = null;
    this.db = null;
    this.initializeStorage();
  }

  async initializeStorage() {
    try {
      const sqliteModule = await import('better-sqlite3').catch(() => null);
      if (sqliteModule && (sqliteModule.default || sqliteModule).prototype) {
        this.sqlite = sqliteModule.default || sqliteModule;
        const dbPath = path.join(DATA_DIR, 'memory.sqlite');
        
        this.db = new this.sqlite(dbPath);
        this.db.pragma('journal_mode = WAL');
        
        // Phase 5: Enhanced schema
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS mem (
            id TEXT PRIMARY KEY,
            text TEXT NOT NULL,
            type TEXT DEFAULT 'conversation',
            priority INTEGER DEFAULT 3,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER,
            source TEXT DEFAULT 'system',
            tags TEXT,
            role TEXT,
            rating INTEGER DEFAULT 0,
            meta TEXT,
            vec TEXT
          )
        `);
        
        // Add new columns if they don't exist (migration)
        try {
          this.db.exec(`ALTER TABLE mem ADD COLUMN type TEXT DEFAULT 'conversation'`);
        } catch (e) { /* Column exists */ }
        try {
          this.db.exec(`ALTER TABLE mem ADD COLUMN priority INTEGER DEFAULT 3`);
        } catch (e) { /* Column exists */ }
        try {
          this.db.exec(`ALTER TABLE mem ADD COLUMN created_at INTEGER`);
        } catch (e) { /* Column exists */ }
        try {
          this.db.exec(`ALTER TABLE mem ADD COLUMN last_used_at INTEGER`);
        } catch (e) { /* Column exists */ }
        try {
          this.db.exec(`ALTER TABLE mem ADD COLUMN source TEXT DEFAULT 'system'`);
        } catch (e) { /* Column exists */ }
        try {
          this.db.exec(`ALTER TABLE mem ADD COLUMN tags TEXT`);
        } catch (e) { /* Column exists */ }
        
        // Create index for faster retrieval
        try {
          this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_type ON mem(type)`);
          this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_priority ON mem(priority)`);
          this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_created ON mem(created_at)`);
        } catch (e) { /* Indexes exist */ }
        
        logger.info('SQLite memory storage initialized (Phase 5 schema)', { path: dbPath });
        await this.loadFromSQLite();
      } else {
        logger.info('SQLite not available, using JSONL storage');
        this.loadFromJSONL();
      }
    } catch (error) {
      logger.error('Storage initialization failed', { error: error.message });
      this.loadFromJSONL();
    }
  }

  async loadFromSQLite() {
    try {
      const rows = this.db.prepare(`
        SELECT id, text, type, priority, created_at, last_used_at, source, tags, role, rating, meta, vec 
        FROM mem ORDER BY created_at ASC
      `).all();
      
      this.memory = rows.map(row => ({
        id: row.id,
        text: row.text,
        type: row.type || 'conversation',
        priority: row.priority || 3,
        created_at: row.created_at || row.ts,
        last_used_at: row.last_used_at,
        source: row.source || 'system',
        tags: row.tags ? JSON.parse(row.tags) : [],
        role: row.role,
        rating: row.rating || 0,
        meta: row.meta ? JSON.parse(row.meta) : {},
        vec: row.vec ? JSON.parse(row.vec) : undefined
      }));
      
      logger.info('Loaded memory from SQLite', { count: this.memory.length });
    } catch (error) {
      logger.error('Failed to load from SQLite', { error: error.message });
    }
  }

  loadFromJSONL() {
    try {
      if (fs.existsSync(VECTORS_PATH)) {
        const lines = fs.readFileSync(VECTORS_PATH, 'utf8')
          .split(/\r?\n/)
          .filter(Boolean);
        
        this.memory = lines.map(line => {
          const item = JSON.parse(line);
          // Migrate old schema
          return {
            id: item.id,
            text: item.text,
            type: item.type || 'conversation',
            priority: item.priority || 3,
            created_at: item.created_at || item.ts || Date.now(),
            last_used_at: item.last_used_at,
            source: item.source || 'system',
            tags: item.tags || [],
            role: item.role,
            rating: item.rating || 0,
            meta: item.meta || {},
            vec: item.vec
          };
        });
        logger.info('Loaded memory from JSONL', { count: this.memory.length });
      }
    } catch (error) {
      logger.error('Failed to load from JSONL', { error: error.message });
    }
  }

  async embed(text) {
    return config.EMBED_PROVIDER === 'openai' ? embedExternal(text) : embedLocal(text);
  }

  /**
   * Store a new memory item (Phase 5 enhanced)
   */
  async store(item) {
    const now = Date.now();
    
    const record = {
      id: item.id || `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      text: String(item.text || ''),
      type: item.type || MemoryType.CONVERSATION,
      priority: Math.min(5, Math.max(1, item.priority || 3)),
      created_at: item.created_at || now,
      last_used_at: item.last_used_at || null,
      source: item.source || MemorySource.SYSTEM,
      tags: Array.isArray(item.tags) ? item.tags : [],
      role: item.role || 'system',
      rating: item.rating || 0,
      meta: item.meta || {},
      vec: Array.isArray(item.vec) ? item.vec : await this.embed(item.text || '')
    };

    this.memory.push(record);

    try {
      if (this.db) {
        this.db.prepare(`
          INSERT OR REPLACE INTO mem (id, text, type, priority, created_at, last_used_at, source, tags, role, rating, meta, vec) 
          VALUES (@id, @text, @type, @priority, @created_at, @last_used_at, @source, @tags, @role, @rating, @meta, @vec)
        `).run({
          id: record.id,
          text: record.text,
          type: record.type,
          priority: record.priority,
          created_at: record.created_at,
          last_used_at: record.last_used_at,
          source: record.source,
          tags: JSON.stringify(record.tags),
          role: record.role,
          rating: record.rating,
          meta: JSON.stringify(record.meta),
          vec: JSON.stringify(record.vec)
        });
      } else {
        fs.appendFileSync(VECTORS_PATH, JSON.stringify(record) + '\n');
      }
      
      logger.debug('[memory] Stored', { id: record.id, type: record.type, priority: record.priority });
    } catch (error) {
      logger.error('Failed to persist memory item', { error: error.message });
    }

    return record;
  }

  // Alias for compatibility
  async upsert(item) {
    return this.store(item);
  }

  /**
   * Update last_used_at timestamp for retrieved memories
   */
  async markUsed(ids) {
    const now = Date.now();
    
    for (const id of ids) {
      const item = this.memory.find(m => m.id === id);
      if (item) {
        item.last_used_at = now;
      }
    }

    if (this.db && ids.length > 0) {
      try {
        const stmt = this.db.prepare(`UPDATE mem SET last_used_at = ? WHERE id = ?`);
        for (const id of ids) {
          stmt.run(now, id);
        }
      } catch (error) {
        logger.warn('Failed to update last_used_at', { error: error.message });
      }
    }
  }

  /**
   * Basic semantic search
   */
  async search(query, k = 5) {
    if (this.memory.length === 0) {
      return [];
    }

    const queryVec = await this.embed(query);
    const scored = this.memory
      .filter(item => item.vec)
      .map(item => ({
        ...item,
        score: cosine(queryVec, item.vec)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    return scored;
  }

  /**
   * Phase 5: Just-in-time memory retrieval with filters
   * @param {string} query - Search query (goal + context)
   * @param {number} k - Max results
   * @param {object} filters - Optional filters
   * @param {number} filters.recency - Max age in ms (e.g., 86400000 for 24h)
   * @param {string[]} filters.tags - Required tags
   * @param {number} filters.minPriority - Minimum priority (1-5)
   * @param {string[]} filters.types - Memory types to include
   * @param {string[]} filters.sources - Memory sources to include
   */
  async retrieveRelevant(query, k = 8, filters = {}) {
    if (this.memory.length === 0) {
      logger.debug('[memory] retrieveRelevant: no memories');
      return [];
    }

    const now = Date.now();
    const queryVec = await this.embed(query);

    // Apply filters
    let candidates = this.memory.filter(item => {
      if (!item.vec) return false;

      // Recency filter
      if (filters.recency && item.created_at) {
        const age = now - item.created_at;
        if (age > filters.recency) return false;
      }

      // Priority filter
      if (filters.minPriority && item.priority < filters.minPriority) {
        return false;
      }

      // Type filter
      if (filters.types && filters.types.length > 0) {
        if (!filters.types.includes(item.type)) return false;
      }

      // Source filter
      if (filters.sources && filters.sources.length > 0) {
        if (!filters.sources.includes(item.source)) return false;
      }

      // Tags filter (must have ALL specified tags)
      if (filters.tags && filters.tags.length > 0) {
        const itemTags = item.tags || [];
        if (!filters.tags.every(tag => itemTags.includes(tag))) {
          return false;
        }
      }

      return true;
    });

    // Score by semantic similarity
    const scored = candidates.map(item => {
      let score = cosine(queryVec, item.vec);
      
      // Boost by priority (priority 5 gets 20% boost)
      score *= (1 + (item.priority - 3) * 0.1);
      
      // Boost recently used items (used in last hour gets 10% boost)
      if (item.last_used_at && (now - item.last_used_at) < 3600000) {
        score *= 1.1;
      }
      
      // Boost high-value types
      if (item.type === MemoryType.PREFERENCE || item.type === MemoryType.CONSTRAINT) {
        score *= 1.15;
      }
      if (item.type === MemoryType.WORKFLOW) {
        score *= 1.1;
      }

      return { ...item, score };
    });

    // Sort by score and take top k
    const results = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    // Mark as used
    if (results.length > 0) {
      await this.markUsed(results.map(r => r.id));
    }

    logger.info('[memory] retrieveRelevant', { 
      query: query.slice(0, 50), 
      candidates: candidates.length,
      returned: results.length,
      filters: Object.keys(filters).filter(k => filters[k] !== undefined)
    });

    return results;
  }

  /**
   * Build retrieval query from agent context
   */
  buildRetrievalQuery(goal, lastAction, lastResult) {
    const parts = [goal];
    
    if (lastAction?.tool) {
      parts.push(`tool: ${lastAction.tool}`);
    }
    
    if (lastResult?.status) {
      parts.push(`result: ${lastResult.status}`);
      if (lastResult.message) {
        parts.push(lastResult.message.slice(0, 100));
      }
    }
    
    return parts.join(' ');
  }

  /**
   * Format memories for LLM injection
   */
  formatForPrompt(memories) {
    if (!memories || memories.length === 0) {
      return '';
    }

    const lines = memories.map(m => {
      const typeLabel = m.type ? `[${m.type.toUpperCase()}]` : '';
      const priorityLabel = m.priority >= 4 ? ' ⚡' : '';
      return `- ${typeLabel}${priorityLabel} ${m.text}`;
    });

    return `RELEVANT_MEMORY:\n${lines.join('\n')}`;
  }

  /**
   * Store a learned preference
   */
  async learnPreference(text, source = MemorySource.LEARNED) {
    return this.store({
      text,
      type: MemoryType.PREFERENCE,
      priority: 4,
      source,
      tags: ['preference']
    });
  }

  /**
   * Store a learned workflow
   */
  async learnWorkflow(text, tags = []) {
    return this.store({
      text,
      type: MemoryType.WORKFLOW,
      priority: 4,
      source: MemorySource.LEARNED,
      tags: ['workflow', ...tags]
    });
  }

  /**
   * Store a constraint/warning
   */
  async learnConstraint(text, source = MemorySource.CORRECTION) {
    return this.store({
      text,
      type: MemoryType.CONSTRAINT,
      priority: 5,
      source,
      tags: ['constraint', 'warning']
    });
  }

  /**
   * Store a fact about the user
   */
  async learnFact(text, source = MemorySource.USER) {
    return this.store({
      text,
      type: MemoryType.FACT,
      priority: 4,
      source,
      tags: ['fact', 'user']
    });
  }

  generatePersona() {
    try {
      const memoryPath = path.join(__dirname, '..', '..', 'memory.json');
      if (fs.existsSync(memoryPath)) {
        const memory = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
        const profile = memory.profile || {};
        const facts = memory.facts || [];
        
        return {
          name: profile.name || 'User',
          preferences: profile.prefs || {},
          facts: facts,
          summary: facts.join(' ')
        };
      }
    } catch (error) {
      logger.error('Failed to generate persona', { error: error.message });
    }
    
    return {
      name: 'User',
      preferences: {},
      facts: [],
      summary: ''
    };
  }

  getStats() {
    const typeBreakdown = {};
    for (const item of this.memory) {
      const type = item.type || 'unknown';
      typeBreakdown[type] = (typeBreakdown[type] || 0) + 1;
    }

    return {
      count: this.memory.length,
      storage: this.db ? 'sqlite' : 'jsonl',
      embeddingProvider: config.EMBED_PROVIDER || 'local',
      types: typeBreakdown
    };
  }
}

const memoryService = new MemoryService();

// Export types for use elsewhere
export { MemoryType, MemorySource };
export default memoryService;
