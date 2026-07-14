// Memory Service - Phase 5: Memory as State
// Just-in-time memory injection for agent decisions
// Schema: text, type, priority, created_at, last_used_at, source, tags

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import avaPaths from '../utils/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = avaPaths.dataDir();
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
  OBSERVATION: 'observation',    // External/community information not yet independently verified
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
  CORRECTION: 'correction', // Learned from user corrections
  COMMUNITY: 'community'  // Moltbook or other external-agent observations
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

function normalizeMemoryText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function memoryFingerprint(item) {
  const material = `${item.type || MemoryType.CONVERSATION}|${item.source || MemorySource.SYSTEM}|${item.role || 'system'}|${normalizeMemoryText(item.text)}`;
  const reverse = [...material].reverse().join('');
  return `${hash(material).toString(36)}${hash(reverse).toString(36)}`;
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
    this.ready = this.initializeStorage();

    // Periodic forgetting: archive stale, low-value memories to the on-device cold vault.
    // Opt-out via AVA_MEMORY_FORGET_ENABLED=0. Conservative defaults (45-day TTL, priority<=2).
    if ((process.env.AVA_MEMORY_FORGET_ENABLED || '1') !== '0') {
      const everyMs = Math.max(1, parseInt(process.env.AVA_MEMORY_FORGET_EVERY_HOURS || '6', 10)) * 3600000;
      this._forgetTimer = setInterval(() => { this.forgetStale().catch(() => {}); }, everyMs);
      if (this._forgetTimer && this._forgetTimer.unref) this._forgetTimer.unref();
    }
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
        // One-time migration: if the SQLite store is empty but a JSONL store exists, import it so
        // switching to SQLite never drops the existing memories. Idempotent (only runs when empty).
        try {
          const existing = this.db.prepare('SELECT COUNT(*) AS n FROM mem').get().n;
          if (existing === 0 && fs.existsSync(VECTORS_PATH)) this._migrateJsonlToSqlite();
        } catch (e) { logger.warn('[memory] JSONL->SQLite migration check failed', { error: e.message }); }
        await this.loadFromSQLite();
        // Safety net: never run with an empty active store when JSONL data exists on disk (e.g. if
        // migration failed). Fall back to the JSONL so no memories are silently dropped.
        if (this.memory.length === 0 && fs.existsSync(VECTORS_PATH)) {
          logger.warn('[memory] SQLite loaded 0 rows but JSONL exists — falling back to JSONL');
          this.loadFromJSONL();
        }
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

  // One-time bulk import of the JSONL store into SQLite, matching store()'s serialization exactly
  // (tags/meta/vec JSON-stringified). Runs inside a transaction for speed. vectors.jsonl is KEPT as
  // a frozen backup (SQLite becomes authoritative; the empty-table guard prevents re-migration).
  _migrateJsonlToSqlite() {
    try {
      const lines = fs.readFileSync(VECTORS_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
      if (!lines.length) return 0;
      const now = Date.now();
      const insert = this.db.prepare(`
        INSERT OR REPLACE INTO mem (id, text, type, priority, created_at, last_used_at, source, tags, role, rating, meta, vec)
        VALUES (@id, @text, @type, @priority, @created_at, @last_used_at, @source, @tags, @role, @rating, @meta, @vec)
      `);
      const run = this.db.transaction((rows) => {
        for (const line of rows) {
          let it; try { it = JSON.parse(line); } catch { continue; }
          insert.run({
            id: it.id || `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            text: String(it.text || ''),
            type: it.type || 'conversation',
            priority: Math.min(5, Math.max(1, it.priority || 3)),
            created_at: it.created_at || it.ts || now,
            last_used_at: it.last_used_at ?? null,
            source: it.source || 'system',
            tags: JSON.stringify(Array.isArray(it.tags) ? it.tags : []),
            role: it.role ?? null,
            rating: it.rating || 0,
            meta: JSON.stringify(it.meta || {}),
            vec: JSON.stringify(it.vec ?? null),
          });
        }
      });
      run(lines);
      const n = this.db.prepare('SELECT COUNT(*) AS n FROM mem').get().n;
      logger.info('[memory] migrated JSONL -> SQLite (vectors.jsonl kept as backup)', { migrated: n });
      return n;
    } catch (e) {
      logger.error('[memory] JSONL->SQLite migration failed', { error: e.message });
      return 0;
    }
  }

  async embed(text) {
    await this.ready;
    return config.EMBED_PROVIDER === 'openai' ? embedExternal(text) : embedLocal(text);
  }

  /**
   * Store a new memory item (Phase 5 enhanced)
   */
  async store(item) {
    await this.ready;
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

    const existingIndex = this.memory.findIndex(memory => memory.id === record.id);
    if (existingIndex >= 0) this.memory[existingIndex] = record;
    else this.memory.push(record);

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

  // Merge equivalent memories instead of multiplying them on every scheduler
  // pass. The fingerprint includes type/source/role so community observations,
  // user constraints, and dialogue never overwrite one another.
  async upsert(item) {
    await this.ready;
    const text = String(item?.text || '').trim();
    if (!text) return null;
    const candidate = { ...item, text };
    const fingerprint = memoryFingerprint(candidate);
    const existing = this.memory.find(memory =>
      memory.meta?.fingerprint === fingerprint || memoryFingerprint(memory) === fingerprint);
    if (!existing) {
      return this.store({
        ...candidate,
        id: candidate.id || `mem-${fingerprint}`,
        meta: { ...(candidate.meta || {}), fingerprint, seenCount: 1, lastSeenAt: Date.now() },
      });
    }

    existing.priority = Math.max(existing.priority || 1, candidate.priority || 1);
    existing.tags = [...new Set([...(existing.tags || []), ...(candidate.tags || [])])];
    existing.rating = Math.max(existing.rating || 0, candidate.rating || 0);
    existing.last_used_at = candidate.last_used_at || existing.last_used_at;
    existing.meta = {
      ...(existing.meta || {}),
      ...(candidate.meta || {}),
      fingerprint,
      seenCount: Math.max(1, Number(existing.meta?.seenCount) || 1) + 1,
      lastSeenAt: Date.now(),
    };
    try {
      if (this.db) {
        this.db.prepare(`UPDATE mem SET priority = ?, last_used_at = ?, tags = ?, rating = ?, meta = ? WHERE id = ?`)
          .run(existing.priority, existing.last_used_at, JSON.stringify(existing.tags), existing.rating, JSON.stringify(existing.meta), existing.id);
      } else {
        fs.writeFileSync(VECTORS_PATH, this.memory.map(memory => JSON.stringify(memory)).join('\n') + '\n');
      }
    } catch (error) {
      logger.warn('[memory] upsert persistence failed', { error: error.message });
    }
    return existing;
  }

  /**
   * Update last_used_at timestamp for retrieved memories
   */
  async markUsed(ids) {
    await this.ready;
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
   * Forgetting: move stale, low-value memories OUT of AVA's active memory into an on-device
   * "cold vault" she does NOT read. Nothing is deleted — it's preserved on disk outside her
   * memory dir/repo, so she genuinely forgets while the data still lives on the machine.
   *
   * Protected and never forgotten: CONSTRAINT, WARNING, PREFERENCE; priority > maxPriority;
   * rated (upvoted) items; anything used within the TTL window; meta.protected.
   *
   * @param {object} opts
   * @param {number} opts.ttlDays   age + idle threshold in days (default AVA_MEMORY_TTL_DAYS=45)
   * @param {number} opts.maxPriority only forget items at/below this priority (default 2)
   * @param {boolean} opts.dryRun    compute what WOULD be forgotten without mutating
   * @param {string}  opts.vaultDir  override the on-device cold-vault directory
   */
  async forgetStale(opts = {}) {
    await this.ready;
    const now = Date.now();
    const ttlDays = opts.ttlDays ?? parseInt(process.env.AVA_MEMORY_TTL_DAYS || '45', 10);
    const maxPriority = opts.maxPriority ?? parseInt(process.env.AVA_MEMORY_FORGET_MAX_PRIORITY || '2', 10);
    const ttlMs = Math.max(0, ttlDays) * 86400000;
    const PROTECTED = new Set([MemoryType.CONSTRAINT, MemoryType.WARNING, MemoryType.PREFERENCE]);

    const toForget = this.memory.filter(m => {
      if (!m) return false;
      if (m.meta && m.meta.protected) return false;     // explicitly pinned
      if (PROTECTED.has(m.type)) return false;           // safety + user prefs stay forever
      if ((m.priority || 3) > maxPriority) return false; // only low-value
      if ((m.rating || 0) > 0) return false;             // keep anything upvoted
      const age = now - (m.created_at || now);
      if (age < ttlMs) return false;                     // not old enough
      const lastUsed = m.last_used_at || m.created_at || now;
      if ((now - lastUsed) < ttlMs) return false;        // recently used -> keep
      return true;
    });

    if (opts.dryRun) {
      return {
        forgotten: toForget.length, dryRun: true, vault: null,
        samples: toForget.slice(0, 8).map(m => ({
          id: m.id, type: m.type, priority: m.priority,
          ageDays: +(((now - (m.created_at || now)) / 86400000).toFixed(1)),
          text: String(m.text || '').slice(0, 70)
        }))
      };
    }
    if (!toForget.length) return { forgotten: 0, vault: null };

    // Append to an on-device vault OUTSIDE AVA's data dir / repo. Nothing in AVA reads this path.
    const vaultDir = opts.vaultDir || process.env.AVA_COLD_STORAGE_DIR || path.join(os.homedir(), 'ava_cold_storage');
    let vaultPath = null;
    try {
      fs.mkdirSync(vaultDir, { recursive: true });
      vaultPath = path.join(vaultDir, 'forgotten-memories.jsonl');
      const archivedAt = new Date().toISOString();
      fs.appendFileSync(vaultPath, toForget.map(m => JSON.stringify({ ...m, archivedAt })).join('\n') + '\n');
    } catch (e) {
      logger.warn('[memory] cold-vault write failed; aborting forget to avoid data loss', { error: e.message });
      return { forgotten: 0, vault: null, error: e.message };  // never drop memories if the vault write failed
    }

    const forgetIds = new Set(toForget.map(m => m.id));
    this.memory = this.memory.filter(m => !forgetIds.has(m.id));
    try {
      if (this.db) {
        const del = this.db.prepare('DELETE FROM mem WHERE id = ?');
        for (const id of forgetIds) del.run(id);
      } else {
        fs.writeFileSync(VECTORS_PATH, this.memory.map(m => JSON.stringify(m)).join('\n') + (this.memory.length ? '\n' : ''));
      }
    } catch (e) {
      logger.warn('[memory] forget: active-store removal failed (already archived to vault)', { error: e.message });
    }

    logger.info('[memory] Forgot stale memories -> on-device cold vault', { forgotten: forgetIds.size, vault: vaultPath });
    return { forgotten: forgetIds.size, vault: vaultPath };
  }

  /**
   * Phase-4 prune for the self-reflection loop: keep only the most recent `keep` raw self-reflection
   * WARNING memories — their content is now captured in the higher-level CONSTRAINT principles, so the
   * store stays lean over time. Archives the pruned ones to the on-device cold vault first (never a
   * hard delete), and touches ONLY source==='self-reflection' WARNING items — never principles, user
   * prefs, or anything else. Returns { pruned, kept }.
   */
  async pruneSelfReflectionWarnings(keep = 25, opts = {}) {
    await this.ready;
    const k = Math.max(0, keep | 0);
    const raws = this.memory
      .filter(m => m && m.type === MemoryType.WARNING && m.source === 'self-reflection')
      .sort((a, b) => (a.created_at || 0) - (b.created_at || 0)); // oldest first
    if (raws.length <= k) return { pruned: 0, kept: raws.length };
    const toPrune = raws.slice(0, raws.length - k);
    const vaultDir = opts.vaultDir || process.env.AVA_COLD_STORAGE_DIR || path.join(os.homedir(), 'ava_cold_storage');
    try {
      fs.mkdirSync(vaultDir, { recursive: true });
      const archivedAt = new Date().toISOString();
      fs.appendFileSync(path.join(vaultDir, 'forgotten-memories.jsonl'),
        toPrune.map(m => JSON.stringify({ ...m, archivedAt, prunedBy: 'self-reflection-distill' })).join('\n') + '\n');
    } catch (e) {
      logger.warn('[memory] self-reflection prune vault write failed; aborting (no data loss)', { error: e.message });
      return { pruned: 0, error: e.message }; // never delete if the archive failed
    }
    const ids = new Set(toPrune.map(m => m.id));
    this.memory = this.memory.filter(m => !ids.has(m.id));
    try {
      if (this.db) { const del = this.db.prepare('DELETE FROM mem WHERE id = ?'); for (const id of ids) del.run(id); }
      else { fs.writeFileSync(VECTORS_PATH, this.memory.map(m => JSON.stringify(m)).join('\n') + (this.memory.length ? '\n' : '')); }
    } catch (e) { logger.warn('[memory] self-reflection prune delete failed', { error: e.message }); }
    logger.info('[memory] pruned raw self-reflection warnings (now captured in principles)', { pruned: toPrune.length, kept: k });
    return { pruned: toPrune.length, kept: k };
  }

  /**
   * Basic semantic search
   */
  async search(query, k = 5) {
    await this.ready;
    if (this.memory.length === 0) {
      return [];
    }

    const queryVec = await this.embed(query);
    const communityIntent = /\b(moltbook|community|other agents?|agent community|what (have|did) you learn)\b/i.test(String(query || ''));
    const seen = new Set();
    const trust = { user: 1.3, correction: 1.35, system: 1.1, learned: 0.95, community: 0.72 };
    const scored = this.memory
      .filter(item => {
        if (!item.vec) return false;
        const isCommunity = item.source === MemorySource.COMMUNITY || (item.tags || []).includes('moltbook');
        if (isCommunity && !communityIntent) return false;
        const key = memoryFingerprint(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(item => ({
        ...item,
        score: cosine(queryVec, item.vec) * (trust[item.source] || 1) * (1 + ((item.priority || 3) - 3) * 0.08)
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
    await this.ready;
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
    return this.upsert({
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
    return this.upsert({
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
    return this.upsert({
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
    return this.upsert({
      text,
      type: MemoryType.FACT,
      priority: 4,
      source,
      tags: ['fact', 'user']
    });
  }

  /** Archive and remove exact semantic duplicates already accumulated on disk. */
  async compactDuplicates({ dryRun = false } = {}) {
    await this.ready;
    const groups = new Map();
    for (const memory of this.memory) {
      const key = memoryFingerprint(memory);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(memory);
    }
    const duplicateGroups = [...groups.entries()].filter(([, entries]) => entries.length > 1);
    const duplicates = [];
    const merged = [];
    for (const [fingerprint, entries] of duplicateGroups) {
      const keep = entries.slice().sort((a, b) =>
        ((b.priority || 0) - (a.priority || 0)) || ((b.rating || 0) - (a.rating || 0)) || ((a.created_at || 0) - (b.created_at || 0)))[0];
      const remove = entries.filter(entry => entry.id !== keep.id);
      keep.tags = [...new Set(entries.flatMap(entry => entry.tags || []))];
      keep.priority = Math.max(...entries.map(entry => entry.priority || 1));
      keep.meta = {
        ...(keep.meta || {}), fingerprint,
        seenCount: entries.reduce((sum, entry) => sum + Math.max(1, Number(entry.meta?.seenCount) || 1), 0),
        compactedAt: Date.now(),
      };
      duplicates.push(...remove);
      merged.push(keep);
    }
    if (dryRun || !duplicates.length) return { groups: duplicateGroups.length, duplicates: duplicates.length, removed: 0 };

    const archiveDir = path.join(DATA_DIR, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, `memory-duplicates-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    fs.writeFileSync(archivePath, duplicates.map(memory => JSON.stringify(memory)).join('\n') + '\n');

    const removeIds = new Set(duplicates.map(memory => memory.id));
    if (this.db) {
      const update = this.db.prepare('UPDATE mem SET priority = ?, tags = ?, meta = ? WHERE id = ?');
      const remove = this.db.prepare('DELETE FROM mem WHERE id = ?');
      const transaction = this.db.transaction(() => {
        for (const memory of merged) update.run(memory.priority, JSON.stringify(memory.tags), JSON.stringify(memory.meta), memory.id);
        for (const id of removeIds) remove.run(id);
      });
      transaction();
    }
    this.memory = this.memory.filter(memory => !removeIds.has(memory.id));
    if (!this.db) fs.writeFileSync(VECTORS_PATH, this.memory.map(memory => JSON.stringify(memory)).join('\n') + '\n');
    logger.info('[memory] compacted duplicates', { groups: duplicateGroups.length, removed: duplicates.length, archivePath });
    return { groups: duplicateGroups.length, duplicates: duplicates.length, removed: duplicates.length, archivePath };
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
      total: this.memory.length,
      storage: this.db ? 'sqlite' : 'jsonl',
      embeddingProvider: config.EMBED_PROVIDER || 'local',
      types: typeBreakdown,
      byType: typeBreakdown,
    };
  }
}

const memoryService = new MemoryService();

// Export types for use elsewhere
export { MemoryType, MemorySource };
export default memoryService;
