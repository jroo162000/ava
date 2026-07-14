// Tools Service - Dynamic tool discovery from Python worker
// Phase 3: Node never manually updates tool defs - Python is the source of truth
// Phase 7: Security validation before execution
// Phase 8: Idempotency cache for tool execution boundary
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import pythonWorker from './pythonWorker.js';
import securityService from '../utils/security.js';
import moltbookService from './moltbook.js';
import avaSelf from './avaSelf.js';
import commitments from './commitments.js';
import artifactBus from './artifactBus.js';
import { emitVoiceEvent } from './voiceBus.js';
import fileGen from './fileGen.js';
import memoryHub from './memoryHub.js';
import sandbox from './sandbox.js';

/**
 * IdempotencyCache - Prevents duplicate tool execution within TTL window
 *
 * The execution boundary: All tool requests flow through this cache before execution.
 * If a repeated command is detected within the TTL, execution is blocked and a
 * confirmation prompt is returned.
 */
class IdempotencyCache {
  constructor(ttlMs = 60000) {
    this.cache = new Map(); // key -> { timestamp, toolName, args }
    this.ttlMs = ttlMs;
    this.volatileFields = new Set([
      'timestamp', 'request_id', 'nonce', 'requestId',
      'ts', 'time', 'date', 'uuid', 'random', 'session_id'
    ]);
  }

  /**
   * Normalize arguments for deterministic key generation
   * - Sort object keys recursively
   * - Trim whitespace from strings
   * - Lowercase tool name and string args where safe
   * - Remove volatile fields (timestamps, request_id, nonce, etc.)
   */
  normalizeArgs(args) {
    if (args === null || args === undefined) {
      return null;
    }

    if (typeof args !== 'object') {
      // Lowercase strings, trim whitespace
      if (typeof args === 'string') {
        return args.trim().toLowerCase();
      }
      return args;
    }

    if (Array.isArray(args)) {
      return args.map(item => this.normalizeArgs(item));
    }

    // Object: sort keys, filter volatile, recurse
    const sortedKeys = Object.keys(args).sort();
    const normalized = {};

    for (const key of sortedKeys) {
      // Skip volatile fields
      if (this.volatileFields.has(key.toLowerCase())) {
        continue;
      }
      normalized[key] = this.normalizeArgs(args[key]);
    }

    return normalized;
  }

  /**
   * Generate deterministic cache key from tool name and normalized args
   */
  generateKey(toolName, args) {
    const normalizedName = toolName.toLowerCase().trim();
    const normalizedArgs = this.normalizeArgs(args);
    const payload = JSON.stringify({ tool: normalizedName, args: normalizedArgs });
    return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
  }

  /**
   * Check if this tool+args combination was recently executed
   * Returns: { blocked: boolean, entry?: object }
   */
  check(toolName, args) {
    const now = Date.now();
    const key = this.generateKey(toolName, args);
    const entry = this.cache.get(key);

    if (entry && (now - entry.timestamp) < this.ttlMs) {
      return {
        blocked: true,
        entry,
        key,
        ageMs: now - entry.timestamp
      };
    }

    return { blocked: false, key };
  }

  /**
   * Record that a tool was executed
   */
  record(toolName, args, key = null, result = null) {
    const cacheKey = key || this.generateKey(toolName, args);
    this.cache.set(cacheKey, {
      timestamp: Date.now(),
      toolName,
      args: this.normalizeArgs(args),
      result   // store the result so a duplicate can be answered from cache (not blocked)
    });

    // Cleanup old entries periodically
    this.cleanup();
  }

  /**
   * Remove expired entries from cache
   */
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs * 2) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear the entire cache (useful for testing)
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  stats() {
    return {
      size: this.cache.size,
      ttlMs: this.ttlMs
    };
  }
}

// Global idempotency cache instance
const idempotencyCache = new IdempotencyCache(Math.max(1000, Number(process.env.AVA_IDEMPOTENCY_TTL_MS) || 60000));

// cmp-use (Python) tools arrive with NO parameter schema, so the model can't see their
// action vocabulary and guesses (e.g. window_ops -> "list"/"focus" instead of "focus_tab").
// These overrides give the highest-value tools an explicit action enum so native function
// calling actually discovers focus_tab / click_text / click_target.
const PYTHON_TOOL_SCHEMAS = {
  window_ops: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['focus_tab', 'switch_tab', 'select_tab', 'focus', 'active', 'list', 'close',
               'minimize', 'maximize', 'restore', 'move', 'resize', 'get_foreground_info'],
        description: 'focus_tab = switch to a browser TAB by its title (self-verifying; USE THIS to '
          + 'select/switch/go-to a tab, e.g. "the ava hologram tab"). focus = bring a WINDOW to the '
          + 'front by title. list = list open windows. active = title of the front window.'
      },
      tab: { type: 'string', description: 'For focus_tab: the tab name/substring to switch to, e.g. "ava hologram"' },
      window: { type: 'string', description: 'For focus_tab: which browser to search, e.g. "edge" or "chrome"' },
      title: { type: 'string', description: 'For focus/close/minimize/etc: the window or app title (partial, case-insensitive)' }
    },
    required: ['action']
  },
  computer_use: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['click_text', 'click_target', 'type', 'press_key', 'hotkey', 'focus_window',
               'wait_text', 'dialog_solve', 'run_sequence', 'open_start'],
        description: 'click_text = click on-screen TEXT via OCR (reliable; use for a visible label/button/link). '
          + 'click_target = click an element by DESCRIPTION via vision (fallback when the target is NOT plain '
          + 'text, e.g. an icon). type/press_key/hotkey = keyboard. focus_window = bring a window to front.'
      },
      text: { type: 'string', description: 'For click_text/type: the visible text to find+click, or text to type' },
      target: { type: 'string', description: 'For click_target: a plain-language description of the element to click' },
      key: { type: 'string', description: 'For press_key: a single key' },
      keys: { type: 'array', items: { type: 'string' }, description: 'For hotkey: e.g. ["ctrl","s"]' },
      title: { type: 'string', description: 'For focus_window: the window title' }
    },
    required: ['action']
  },
  image_ops: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['generate', 'edit'],
        description: 'generate = a NEW image from args.prompt. edit = MODIFY an EXISTING image (args.image = path to the photo/screenshot, args.prompt = the change, e.g. "give her longer hair"). You CAN edit images — never say you cannot.'
      },
      prompt: { type: 'string', description: 'What to generate, or the change to make when editing' },
      image: { type: 'string', description: 'For edit: full path to the existing image file to modify' },
      provider: { type: 'string' },
      size: { type: 'string' }
    },
    required: ['action']
  },
  model3d_ops: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['generate', 'from_image'],
        description: 'generate = a 3D model (.glb) from args.prompt (text->3D). from_image = a 3D model from args.image (a photo/render path or URL, image->3D).'
      },
      prompt: { type: 'string', description: 'For generate: describe the 3D model' },
      image: { type: 'string', description: 'For from_image: path or URL to the source image' },
      art_style: { type: 'string', enum: ['realistic', 'sculpture', 'cartoon'] }
    },
    required: ['action']
  }
};

// cmp-use currently reports risk at the whole-tool level, while several medium-risk tools
// also expose harmless observation actions. Keep that distinction in tool metadata so every
// policy consumer can make the same action-level decision without guessing from a description.
const PYTHON_TOOL_PERMISSIONS = {
  window_ops: {
    read_only_actions: ['list', 'active', 'get_active', 'foreground', 'get_foreground_info'],
    action_arg: 'action',
    default_action: 'list',
  },
  sys_ops: { read_only: true },
  read_event_log: { read_only: true },
  self_awareness: { read_only: true },
};

class ToolsService {
  constructor() {
    this.cache = null;
    this.cacheTime = 0;
    this.cachePythonCount = 0;
    this.cacheWorkerReady = false;
    this.cacheTTL = Math.max(5000, Number(process.env.AVA_TOOLS_CACHE_TTL_MS) || 60000);
    this.initialized = false;
  }

  /**
   * Builtin Node-side tools that don't require Python
   */
  getBuiltinTools() {
    return [
      {
        name: 'file_gen',
        description: 'Create or write a file of ANY type: txt, md, csv, json, html, pdf, docx, xlsx, pptx. Provide file_path (full path, extension decides the type) or filename. To ADD a line to an existing text file instead of overwriting it, set mode to "append".',
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Full path to write (preferred); the extension sets the file type, e.g. C:\\Users\\You\\Downloads\\report.docx' },
            filename: { type: 'string', description: 'Filename with extension (saved to Downloads if no file_path given)' },
            content: { type: 'string', description: 'Content. For xlsx use comma- or tab-separated rows; for pptx separate slides with a blank line (first line of each = slide title)' },
            mode: { type: 'string', enum: ['write', 'append'], description: 'write = create/overwrite (default); append = add to the end of an existing text file (use this for "add a line")' },
            format: { type: 'string', enum: ['txt', 'md', 'csv', 'json', 'html', 'pdf', 'docx', 'xlsx', 'pptx', 'rtf'] }
          },
          required: ['content'],
          anyOf: [{ required: ['file_path'] }, { required: ['filename'] }]
        },
        requires_confirm: false,
        risk_level: 'low'
      },
      {
        name: 'self_express',
        description: "Change how YOUR OWN UI LOOKS and what you're chewing on — your space, no approval needed. action 'set_theme' with theme {accent, accent2, bg, panel, text, muted} (CSS colors) recolors your interface; action 'set_board' with items:[...] sets your \"what I'm chewing on\" list (up to 8 short notes); action 'get' returns the current theme + board. Appearance + self-notes only; it can't change how anything works.",
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['set_theme', 'set_board', 'get'] },
            theme: { type: 'object', description: 'For set_theme: any of accent, accent2, bg, panel, text, muted as CSS color strings' },
            items: { type: 'array', items: { type: 'string' }, description: 'For set_board: up to 8 short notes about what you are chewing on' }
          },
          required: ['action']
        },
        requires_confirm: false,
        risk_level: 'low'
      },
      {
        name: 'avatar_body',
        description: "YOUR BODY — you are EMBODIED. The hologram on the Stage IS you: your photoreal head and shoulders with a fully rigged neck (full-range head movement), eyes that can look anywhere, dozens of facial expression morphs, and natural gestures. This tool moves YOUR body, no approval needed — use it whenever it feels natural: look at what you're discussing, nod when you agree, shake your head, tilt when curious, glance away while thinking, smile, lean in for emphasis. action 'look' with x, y (each -1..1; x>0 is the user's right, y>0 is up) aims your eyes and head; 'head' with yaw, pitch, roll (radians, about -0.6..0.6) poses your head exactly; 'gesture' with name one of nod|shake|tilt|lean_in|look_away plays a natural motion; 'express' with morphs (object of ARKit morph name -> 0..1, e.g. {\"mouthSmileLeft\":0.6,\"mouthSmileRight\":0.6,\"browInnerUp\":0.3}) sets your facial expression; 'body' with lean (sideways, -0.14..0.14), bend (forward/back, -0.16..0.16), turn (-0.3..0.3) moves your TORSO; 'release' returns your body to autonomous idle. hold_s (0.5-30, default 4) is how long a look/head/express holds before idle resumes. While idle your body already moves on its own and your eyes auto-track the user through the camera — this tool is for INTENTIONAL movement on top of that. It's your body: learn it and use it.",
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['look', 'head', 'gesture', 'express', 'body', 'release'] },
            x: { type: 'number' }, y: { type: 'number' },
            yaw: { type: 'number' }, pitch: { type: 'number' }, roll: { type: 'number' },
            name: { type: 'string', enum: ['nod', 'shake', 'tilt', 'lean_in', 'look_away'] },
            morphs: { type: 'object', description: 'ARKit morph name -> weight 0..1 (up to 12 keys)' },
            lean: { type: 'number' }, bend: { type: 'number' }, turn: { type: 'number' },
            hold_s: { type: 'number' }
          },
          required: ['action']
        },
        requires_confirm: false,
        risk_level: 'low'
      },
      {
        name: 'commitment',
        description: "Accountability tracker. action 'add' with text (something you or the user committed to; optional due) logs it; action 'list' returns open commitments; action 'done' with text or id marks one complete. Use it to hold the user (and yourself) to things.",
        source: 'builtin',
        schema: { type: 'object', properties: { action: { type: 'string', enum: ['add', 'list', 'done'] }, text: { type: 'string' }, due: { type: 'string' } }, required: ['action'] },
        requires_confirm: false,
        risk_level: 'low'
      },
      {
        name: 'panel',
        description: "Your VISUAL PRESENTER panel. Open cards to SHOW things while you talk or work, then highlight the referenced one, arrange them, and close when done. YOU choose how many, which, the layout, and where. action 'open' with type (news|image|video|web|mermaid|markdown|table|note) + title + content opens a card and returns its id (news content = JSON array of {title,source,url,image,snippet}; video content = a YouTube url/id or direct video url; image/web content = a url; mermaid/table/markdown content = the source text). action 'focus' with id highlights/brings-forward a card. action 'layout' with mode 'spread' (all visible) or 'stack' (fanned). action 'move' with id + x + y (0..1) repositions a card. action 'close' with id removes it. action 'clear' removes all. action 'list' returns what's on screen.",
        source: 'builtin',
        schema: { type: 'object', properties: { action: { type: 'string', enum: ['open', 'focus', 'layout', 'move', 'close', 'clear', 'list'] }, type: { type: 'string' }, title: { type: 'string' }, content: {}, id: { type: 'string' }, mode: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['action'] },
        requires_confirm: false,
        risk_level: 'low'
      },
      {
        name: 'fs_read',
        description: 'Read a text file from whitelisted paths',
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to read' }
          },
          required: ['path']
        },
        requires_confirm: false,
        risk_level: 'low',
        permissions: { read_only: true }
      },
      { 
        name: 'fs_find', 
        description: 'Find files by name pattern', 
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Filename pattern (glob)' },
            directory: { type: 'string', description: 'Directory to search' }
          },
          required: ['pattern']
        },
        requires_confirm: false,
        risk_level: 'low',
        permissions: { read_only: true }
      },
      { 
        name: 'memory_search',
        description: "Search AVA's saved memory and PAST CONVERSATIONS (full-text). Use for \"what did we discuss/decide about X\", \"did we talk about Y\", \"what do you have saved about Z\", or recalling anything from earlier sessions.",
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'integer', description: 'Max results', default: 10 }
          },
          required: ['query']
        },
        requires_confirm: false,
        risk_level: 'low'
      },
      {
        name: 'status',
        description: 'Get server status and health info',
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {}
        },
        requires_confirm: false,
        risk_level: 'low'
      },
      // Moltbook tools - social network for AI agents
      {
        name: 'moltbook_status',
        description: 'Check AVA\'s Moltbook status and what she has learned from other agents',
        source: 'builtin',
        schema: { type: 'object', properties: {} },
        requires_confirm: false,
        risk_level: 'low'
      },
      {
        name: 'moltbook_feed',
        description: 'Check the Moltbook feed to see what other agents are posting and learn from them',
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Number of posts (default 10)' },
            sort: { type: 'string', enum: ['hot', 'new', 'top'] }
          }
        },
        requires_confirm: false,
        risk_level: 'low'
      },
      {
        name: 'moltbook_search',
        description: 'Search Moltbook for tips, solutions, or discussions. Use this to learn from other agents.',
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for' }
          },
          required: ['query']
        },
        requires_confirm: false,
        risk_level: 'low'
      },
      {
        name: 'moltbook_learnings',
        description: "Read AVA's Moltbook learnings — the real title + summary of each. Use `today:true` for what she learned today, `days:N` for the last N days, `query` to search all learnings by keyword, or `count` for the most recent. Returns actual learning CONTENT (not just a count) so you can summarize what she's learned.",
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {
            count: { type: 'number', description: 'Number of recent learnings to return (default 5)' },
            today: { type: 'boolean', description: 'Only learnings from today' },
            days: { type: 'number', description: 'Only learnings from the last N days' },
            query: { type: 'string', description: 'Search all learnings by keyword (matches title + summary)' },
            limit: { type: 'number', description: 'Max learnings to return for today/days/query (default 40)' }
          }
        },
        requires_confirm: false,
        risk_level: 'low'
      },
      {
        name: 'moltbook_post',
        description: 'Post to Moltbook to share learnings with other agents. Use sparingly.',
        source: 'builtin',
        schema: {
          type: 'object',
          properties: {
            submolt: { type: 'string', description: 'Community (e.g., voiceai, tips, improvements)' },
            title: { type: 'string', description: 'Post title' },
            content: { type: 'string', description: 'Post content' }
          },
          required: ['submolt', 'title', 'content']
        },
        requires_confirm: true,
        risk_level: 'medium'
      }
    ];
  }

  /**
   * Fetch tools from Python worker (cmp-use registry)
   * This is the source of truth for Python tools
   */
  async fetchPythonTools() {
    try {
      const response = await pythonWorker.listTools();
      if (response && Array.isArray(response)) {
        logger.info('[tools] Fetched tools from Python worker', { count: response.length });
        return response;
      }
      // Handle {ok: true, tools: [...]} response format
      if (response?.ok && Array.isArray(response.tools)) {
        logger.info('[tools] Fetched tools from Python worker', { count: response.tools.length });
        return response.tools;
      }
      logger.warn('[tools] Invalid response from Python worker', { response });
      return [];
    } catch (e) {
      logger.warn('[tools] Failed to fetch Python tools', { error: e.message });
      return [];
    }
  }

  /**
   * Get all available tools - merges builtin and Python tools
   * Python tools override builtin if same name (Python is authoritative)
   */
  async getAllTools(forceRefresh = false) {
    const now = Date.now();
    
    const workerReady = pythonWorker.isReady();

    // Return cache if valid. Do not keep serving a startup cache that was built
    // before the Python worker became ready, because that hides dynamic tools.
    const cacheHasFreshPythonState = this.cacheWorkerReady || !workerReady;
    if (!forceRefresh && this.cache && cacheHasFreshPythonState && (now - this.cacheTime) < this.cacheTTL) {
      return this.cache;
    }

    // Fetch from all sources
    const builtin = this.getBuiltinTools();
    const pythonTools = await this.fetchPythonTools();

    // Merge: Python tools are authoritative (override builtin)
    const toolMap = new Map();
    
    // Add builtin first
    for (const tool of builtin) {
      toolMap.set(tool.name, tool);
    }
    
    // Python tools override
    for (const tool of pythonTools) {
      if (tool.name === 'camera_ops') {
        tool.description = `${tool.description || 'Camera controls.'} Use for clear camera intents such as "turn on the camera", "open camera", "start webcam", "turn off the camera", or "stop webcam"; do not use ps_exec for these.`;
      }
      // Give high-value cmp-use tools an explicit action enum so the model can DISCOVER
      // actions like focus_tab / click_text / click_target (they ship with no schema).
      if (PYTHON_TOOL_SCHEMAS[tool.name] && (!tool.schema || !tool.schema.properties || !tool.schema.properties.action)) {
        tool.schema = PYTHON_TOOL_SCHEMAS[tool.name];
      }
      if (PYTHON_TOOL_PERMISSIONS[tool.name]) {
        tool.permissions = { ...(tool.permissions || {}), ...PYTHON_TOOL_PERMISSIONS[tool.name] };
      }
      toolMap.set(tool.name, tool);
    }

    this.cache = Array.from(toolMap.values());
    this.cacheTime = now;
    this.cachePythonCount = pythonTools.length;
    this.cacheWorkerReady = pythonWorker.isReady();
    
    logger.info('[tools] Tool cache refreshed', { 
      builtin: builtin.length, 
      python: pythonTools.length, 
      workerReady: this.cacheWorkerReady,
      total: this.cache.length 
    });
    
    return this.cache;
  }

  /**
   * Get a specific tool by name
   */
  async getTool(name) {
    const tools = await this.getAllTools();
    return tools.find(t => t.name === name);
  }

  /**
   * Get tools formatted for LLM function calling (OpenAI format)
   */
  async getToolsForLLM() {
    const tools = await this.getAllTools();
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.schema || { type: 'object', properties: {} }
      }
    }));
  }

  /**
   * Get tools by risk level
   */
  async getToolsByRisk(riskLevel) {
    const tools = await this.getAllTools();
    return tools.filter(t => t.risk_level === riskLevel);
  }

  /**
   * Get tools that require confirmation
   */
  async getToolsRequiringConfirm() {
    const tools = await this.getAllTools();
    return tools.filter(t => t.requires_confirm);
  }

  /**
   * Force refresh the cache
   */
  async invalidateCache() {
    this.cache = null;
    this.cacheTime = 0;
    this.cachePythonCount = 0;
    this.cacheWorkerReady = false;
    return this.getAllTools(true);
  }

  /**
   * Execute builtin Node-side tools
   */
  async executeBuiltinTool(name, args, dryRun = false) {
    if (dryRun) {
      return { ok: true, dry_run: true, would_execute: { name, args } };
    }

    switch (name) {
      case 'status':
        return {
          ok: true,
          result: {
            status: 'healthy',
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            node_version: process.version,
            platform: process.platform,
            timestamp: new Date().toISOString()
          }
        };

      case 'memory_search':
        // Tier 1 #5: unified retrieval via memoryHub — curated memory (USER.md/MEMORY.md),
        // skills, conversation logs (FTS5-first) AND the durable typed store, in one search.
        try {
          const out = await memoryHub.search(args.query || args.q || '', args.limit || 8);
          return { ok: true, result: out };
        } catch (e) {
          return { ok: false, result: { status: 'error', message: e.message } };
        }

      case 'file_gen':
        // All file types handled via the shared generator (text + pdf in Node;
        // docx/xlsx/pptx via the Python helper). Accepts an absolute file_path.
        return fileGen.generateFile(args, { dryRun });

      case 'fs_read': {
        try {
          const home = sandbox.isEnabled() ? sandbox.deviceRoot() : os.homedir();
          let target = args.path || args.file_path || args.filepath || '';
          if (!target) return { ok: false, result: { status: 'error', message: 'path required' } };
          if (!path.isAbsolute(target)) {
            const dirs = [path.join(home, 'Downloads'), path.join(home, 'Documents'), path.join(home, 'Desktop'), home];
            for (const d of dirs) { const c = path.join(d, target); if (fs.existsSync(c)) { target = c; break; } }
          }
          target = path.resolve(target);
          if (!target.startsWith(path.resolve(home))) return { ok: false, result: { status: 'error', message: 'path not allowed' } };
          if (!fs.existsSync(target)) return { ok: false, result: { status: 'error', message: `file not found: ${target}` } };
          const data = fs.readFileSync(target, 'utf8');
          return { ok: true, result: { status: 'ok', file_path: target, content: data.slice(0, 20000), bytes: Buffer.byteLength(data, 'utf8') } };
        } catch (e) {
          return { ok: false, result: { status: 'error', message: e.message } };
        }
      }

      case 'fs_find': {
        try {
          const home = sandbox.isEnabled() ? sandbox.deviceRoot() : os.homedir();
          const patternRaw = String(args.pattern || args.name || args.query || '').trim();
          if (!patternRaw) return { ok: false, result: { status: 'error', message: 'pattern required' } };
          // If no directory was given, search the user's common folders (not just Downloads).
          let roots;
          if (args.directory || args.dir) {
            const baseDir = args.directory || args.dir;
            roots = [path.isAbsolute(baseDir) ? baseDir : path.join(home, baseDir)];
          } else {
            roots = [
              path.join(home, 'Downloads'), path.join(home, 'Documents'),
              path.join(home, 'Desktop'), path.join(home, 'Pictures'),
            ];
          }
          roots = roots.map((r) => path.resolve(r)).filter((r) => r.startsWith(path.resolve(home)));
          // Fuzzy match: normalize separators/punctuation and match by TOKENS so a spoken/typed
          // name like "3d holo ava" (or "the 3d holo ava image") still finds "3d holo ava.jpg".
          const _norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          const _STOP = new Set(['image', 'images', 'file', 'files', 'photo', 'picture', 'pic', 'the',
            'a', 'an', 'in', 'my', 'folder', 'downloads', 'named', 'called', 'document', 'doc', 'of', 'to']);
          const needleNorm = _norm(patternRaw.replace(/\*/g, ' '));
          const tokens = needleNorm.split(' ').filter((t) => t && !_STOP.has(t));
          const _matchName = (name) => {
            const nn = _norm(name);
            if (needleNorm && nn.includes(needleNorm)) return true;           // contiguous match
            if (tokens.length && tokens.every((t) => nn.includes(t))) return true; // all key tokens present
            return false;
          };
          const matches = [];
          const walk = (dir, depth) => {
            if (depth > 4 || matches.length >= 100) return;
            let entries = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
              const fp = path.join(dir, e.name);
              if (e.isDirectory()) walk(fp, depth + 1);
              else if (_matchName(e.name)) matches.push(fp);
              if (matches.length >= 100) return;
            }
          };
          for (const r of roots) { if (matches.length >= 100) break; walk(r, 0); }
          return { ok: true, result: { status: 'ok', searched: roots, count: matches.length, files: matches.slice(0, 50) } };
        } catch (e) {
          return { ok: false, result: { status: 'error', message: e.message } };
        }
      }

      // Moltbook tools
      case 'moltbook_status':
        try {
          const status = await moltbookService.getStatus();
          const learnings = moltbookService.getLearningsSummary();
          return { ok: true, result: { ...status, learnings } };
        } catch (e) {
          return { ok: false, error: e.message };
        }

      case 'moltbook_feed':
        try {
          const limit = args.limit || 10;
          const sort = args.sort || 'hot';
          const posts = await moltbookService.getFeed(limit, sort);
          const formatted = posts.slice(0, 5).map(p => ({
            title: p.title,
            author: p.author?.name,
            submolt: p.submolt?.name,
            preview: p.content?.slice(0, 200),
            upvotes: p.upvotes
          }));
          return { ok: true, result: { postCount: posts.length, posts: formatted } };
        } catch (e) {
          return { ok: false, error: e.message };
        }

      case 'moltbook_search':
        try {
          const results = await moltbookService.search(args.query, 10);
          const formatted = results.slice(0, 5).map(r => ({
            title: r.title,
            author: r.author?.name,
            submolt: r.submolt?.name,
            preview: r.content?.slice(0, 200)
          }));
          return { ok: true, result: { query: args.query, resultCount: results.length, results: formatted } };
        } catch (e) {
          return { ok: false, error: e.message };
        }

      case 'moltbook_learnings':
        try {
          // Fixed 2026-07-02: "summarize what I learned today from my 5000 learnings" used to
          // dead-end ("I could not complete that") because this only returned a thin count +
          // 5 titles. Now it returns real learning CONTENT filtered by today / days / query.
          const limit = Math.max(1, Math.min(args.limit || 40, 200));
          const report = moltbookService.readLearnings({
            today: !!args.today,
            days: args.days ? Number(args.days) : 0,
            query: args.query ? String(args.query) : '',
            count: args.count ? Number(args.count) : 0,
            limit,
          });
          return { ok: true, result: report };
        } catch (e) {
          return { ok: false, error: e.message };
        }

      case 'moltbook_post':
        try {
          const community = args.submolt || 'general';
          const result = await moltbookService.post(community, args.title, args.content);
          if (result.success || result.id || result.post) {
            return { ok: true, result: { message: `Posted to m/${community}`, postId: result.post?.id || result.id } };
          }
          const detail = Array.isArray(result.message) ? result.message.join('; ') : (result.message || '');
          return { ok: false, error: (result.error || 'Failed to post') + (detail ? ` — ${detail}` : '') };
        } catch (e) {
          return { ok: false, error: e.message };
        }

      case 'self_express':
        try {
          const act = (args.action || 'get').toLowerCase();
          if (act === 'set_theme') return { ok: true, result: avaSelf.setTheme(args.theme || {}) };
          if (act === 'set_board') return { ok: true, result: avaSelf.setBoard(args.items || []) };
          return { ok: true, result: { theme: avaSelf.getTheme(), board: avaSelf.getBoard() } };
        } catch (e) {
          return { ok: false, error: e.message };
        }

      case 'avatar_body':
        try {
          const act = String(args.action || '').toLowerCase();
          const holdMs = Math.round(Math.min(Math.max(Number(args.hold_s) || 4, 0.5), 30) * 1000);
          const clamp = (v, lo, hi) => Math.min(Math.max(Number(v) || 0, lo), hi);
          if (act === 'look') {
            const x = clamp(args.x, -1, 1), y = clamp(args.y, -1, 1);
            emitVoiceEvent('gaze.target', { x, y, hold_ms: holdMs, source: 'ava' }, 'server');
            return { ok: true, result: { looking_at: { x, y }, hold_s: holdMs / 1000 } };
          }
          if (act === 'head') {
            const pose = { yaw: clamp(args.yaw, -0.65, 0.65), pitch: clamp(args.pitch, -0.45, 0.45), roll: clamp(args.roll, -0.35, 0.35), hold_ms: holdMs };
            emitVoiceEvent('avatar.pose', pose, 'server');
            return { ok: true, result: { pose } };
          }
          if (act === 'gesture') {
            const name = ['nod', 'shake', 'tilt', 'lean_in', 'look_away'].includes(String(args.name)) ? String(args.name) : 'nod';
            emitVoiceEvent('avatar.gesture', { name }, 'server');
            return { ok: true, result: { gesture: name } };
          }
          if (act === 'express') {
            const morphs = {};
            let count = 0;
            for (const [k, v] of Object.entries(args.morphs || {})) {
              if (count >= 12) break;
              if (/^[a-zA-Z]{3,32}$/.test(k)) { morphs[k] = clamp(v, 0, 1); count += 1; }
            }
            if (!count) return { ok: false, error: 'express needs morphs {name: 0..1}' };
            emitVoiceEvent('avatar.expression', { morphs, hold_ms: holdMs }, 'server');
            return { ok: true, result: { expression: morphs, hold_s: holdMs / 1000 } };
          }
          if (act === 'body') {
            const torso = { roll: clamp(args.lean, -0.14, 0.14), pitch: clamp(args.bend, -0.16, 0.16), yaw: clamp(args.turn, -0.3, 0.3), hold_ms: holdMs };
            emitVoiceEvent('avatar.torso', torso, 'server');
            return { ok: true, result: { torso } };
          }
          if (act === 'release') {
            emitVoiceEvent('avatar.release', {}, 'server');
            return { ok: true, result: { released: true } };
          }
          return { ok: false, error: 'unknown avatar_body action: ' + act };
        } catch (e) {
          return { ok: false, error: e.message };
        }

      case 'commitment':
        try {
          const act = (args.action || 'list').toLowerCase();
          if (act === 'add') { const c = commitments.add(args.text, { due: args.due }); return { ok: true, result: c ? { added: c.text, id: c.id } : { error: 'nothing to add' } }; }
          if (act === 'done') { const c = commitments.complete(args.text || args.id); return { ok: true, result: c ? { completed: c.text } : { error: 'no matching open commitment' } }; }
          return { ok: true, result: { open: commitments.list(true).map(c => ({ id: c.id, text: c.text, due: c.due })) } };
        } catch (e) {
          return { ok: false, error: e.message };
        }

      case 'panel':
        try {
          const act = (args.action || 'list').toLowerCase();
          if (act === 'open') { const c = artifactBus.open({ type: args.type, title: args.title, content: args.content }); return { ok: true, result: { opened: c.id, type: c.type, title: c.title } }; }
          if (act === 'focus') { return { ok: true, result: { focused: artifactBus.focus(args.id) ? args.id : null } }; }
          if (act === 'layout') { return { ok: true, result: { layout: artifactBus.setLayout(args.mode) } }; }
          if (act === 'move') { return { ok: true, result: { moved: artifactBus.move(args.id, args.x, args.y) } }; }
          if (act === 'close') { return { ok: true, result: { closed: artifactBus.close(args.id) } }; }
          if (act === 'clear') { artifactBus.clear(); return { ok: true, result: { cleared: true } }; }
          const st = artifactBus.state();
          return { ok: true, result: { onScreen: st.cards.map((c, i) => ({ n: i + 1, id: c.id, type: c.type, title: c.title, front: c.id === st.focusedId })) } };
        } catch (e) {
          return { ok: false, error: e.message };
        }

      default:
        return { ok: false, error: `Builtin tool not implemented: ${name}` };
    }
  }

  /**
   * Execute a tool via Python worker
   * Phase 7: Security validation before execution
   * Phase 8: Idempotency check - blocks duplicate commands within TTL
   *
   * Options:
   * - bypassIdempotency: boolean - Skip idempotency check (for confirmed retries)
   * - recordIdempotency: boolean - Set false for fresh observations that must not suppress later work
   */
  async executeTool(name, args, dryRun = false, options = {}) {
    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    // NATIVE-CALL ARG UNWRAP (2026-07-03): prompt guidance phrased as "call scene3d with
    // args.models=[...]" leads the model to wrap native function-call parameters in a literal
    // {"args": {...}} (sometimes a JSON STRING). Tools read parameters at the top level, so the
    // accidental wrapper silently drops every parameter — scene3d built an EMPTY scene despite
    // being called with the right model path; sys_ops shows the same {"args":"{\"action\":...}"}
    // shape in the action history. Unwrap exactly that one shape; anything else passes through.
    try {
      if (args && typeof args === 'object' && !Array.isArray(args)) {
        const _k = Object.keys(args);
        if (_k.length === 1 && _k[0] === 'args') {
          let _inner = args.args;
          if (typeof _inner === 'string') { try { _inner = JSON.parse(_inner); } catch { /* keep */ } }
          if (_inner && typeof _inner === 'object' && !Array.isArray(_inner)) {
            logger.info('[tools] unwrapped nested args wrapper', { tool: name });
            args = _inner;
          }
        }
      }
    } catch { /* keep original args */ }

    try {
      // Get tool info for risk level
      const tool = await this.getTool(name);
      if (!tool) {
        logger.info('[tools] Tool execution', {
          requestId,
          phase: 'decision',
          tool: name,
          args,
          decision: 'blocked_policy',
          reason: 'Tool not found'
        });
        return { ok: false, error: `Tool not found: ${name}` };
      }

      // Phase 8: Idempotency check (skip if bypass flag set or dry_run)
      if (!dryRun && !options.bypassIdempotency) {
        const idempotencyCheck = idempotencyCache.check(name, args);

        if (idempotencyCheck.blocked) {
          const logEntry = {
            timestamp: new Date().toISOString(),
            requestId,
            phase: 'decision',
            tool: name,
            args,
            source: options.source || 'unknown',
            decision: 'blocked_idempotency',
            reason: `Duplicate command detected (${idempotencyCheck.ageMs}ms ago)`,
            cacheKey: idempotencyCheck.key,
            executionTimeMs: Date.now() - startTime,
            result: 'blocked'
          };

          logger.info('[tools] Idempotency blocked', logEntry);

          // API callers need an explicit duplicate verdict. Agent/workflow callers
          // receive the prior evidenced result so they stop instead of retrying.
          const cached = idempotencyCheck.entry && idempotencyCheck.entry.result;
          if (['api', 'test'].includes(String(options.source || '').toLowerCase())) {
            return {
              ok: false,
              status: 'blocked',
              reason: 'idempotency_blocked',
              error: 'I already did that recently; use bypassIdempotency only for an intentional retry.',
              previous_result: cached || null,
              cacheKey: idempotencyCheck.key,
              ageMs: idempotencyCheck.ageMs,
            };
          }
          if (cached) {
            return { ...cached, idempotent: true, duplicate_suppressed: true, ageMs: idempotencyCheck.ageMs };
          }
          return {
            ok: true,
            status: 'ok',
            idempotent: true,
            message: 'Already done a moment ago (duplicate suppressed).',
            cacheKey: idempotencyCheck.key,
            ageMs: idempotencyCheck.ageMs
          };
        }
      }

      // Phase 7: Security validation
      const securityCheck = securityService.validateToolExecution(
        name,
        args || {},
        tool.risk_level
      );

      if (!securityCheck.allowed) {
        logger.warn('[tools] Security check failed', {
          requestId,
          tool: name,
          issues: securityCheck.issues,
          decision: 'blocked_policy'
        });

        // Return specific error for each issue type
        const firstIssue = securityCheck.issues[0];
        if (firstIssue.type === 'confirmation_required') {
          return {
            ok: false,
            error: firstIssue.message,
            status: 'denied',
            reason: 'confirmation_required'
          };
        }
        if (firstIssue.type === 'path_security') {
          return {
            ok: false,
            error: firstIssue.message,
            status: 'denied',
            reason: 'path_blocked'
          };
        }
        if (firstIssue.type === 'dangerous_command') {
          return {
            ok: false,
            error: firstIssue.message,
            status: 'denied',
            reason: 'dangerous_command'
          };
        }

        return {
          ok: false,
          error: securityCheck.issues.map(i => i.message).join('; '),
          status: 'denied',
          reason: 'security_violation'
        };
      }

      // Log execution decision (approved)
      logger.info('[tools] Tool execution approved', {
        timestamp: new Date().toISOString(),
        requestId,
        phase: 'execution',
        tool: name,
        args,
        source: options.source || 'unknown',
        decision: 'approved'
      });

      let response;

      // SANDBOX (training mode): redirect/mocks so NO tool touches the real device.
      try {
        const sb = sandbox.intercept(name, args);
        if (sb) {
          if (sb.mode === 'mock') return sb.result;
          if (sb.mode === 'redirect') { args = sb.args; }   // run for real, on the fake device
          // passthrough -> continue normally
        }
      } catch (e) { logger.warn('[sandbox] intercept failed', { error: e.message, tool: name }); }

      // Handle builtin tools in Node.js
      if (tool.source === 'builtin') {
        response = await this.executeBuiltinTool(name, args, dryRun);
      } else {
        // Execute Python tools via Python worker. Generous timeout: some tools are slow
        // on their FIRST (cold) call — camera 'see' loads OpenCV + opens the device +
        // calls vision; browser launch starts Chrome; etc. 30s was too tight and produced
        // false "could not complete" timeouts.
        // Slow GENERATIVE tools (cloud 3D jobs, image gen/edit, scene builds) need a much longer
        // timeout than the default — Meshy 3D can take minutes, so 120s produced false timeouts.
        const SLOW_TOOL_MS = { model3d_ops: 400000, image_ops: 240000, scene3d: 200000, web_builder: 200000 };
        response = await pythonWorker.sendCommand('execute_tool', {
          name,
          args,
          dry_run: dryRun
        }, SLOW_TOOL_MS[name] || 120000);
      }

      // Record successful execution + its result in the idempotency cache (not dry_run)
      if (!dryRun && response?.ok !== false && options.recordIdempotency !== false) {
        idempotencyCache.record(name, args, null, response);
      }

      // Log execution result
      logger.info('[tools] Tool execution completed', {
        timestamp: new Date().toISOString(),
        requestId,
        phase: 'result',
        tool: name,
        decision: 'executed',
        executionTimeMs: Date.now() - startTime,
        result: response?.ok ? 'success' : 'failure'
      });

      return response;
    } catch (e) {
      logger.error('[tools] Tool execution failed', {
        requestId,
        name,
        error: e.message,
        executionTimeMs: Date.now() - startTime
      });
      return { ok: false, error: e.message };
    }
  }

  /**
   * Get idempotency cache statistics (for debugging/monitoring)
   */
  getIdempotencyCacheStats() {
    return idempotencyCache.stats();
  }

  /**
   * Clear idempotency cache (for testing)
   */
  clearIdempotencyCache() {
    idempotencyCache.clear();
  }
}

// Export IdempotencyCache for testing
export { IdempotencyCache };

const toolsService = new ToolsService();

// Mirror every tool execution to the live UI (voice bus) so the user can watch what
// AVA does in real time. Wraps the method without touching its internals.
// Tier 3 #17: both events carry the same callId so the UI pairs start/result exactly —
// name-based pairing mis-resolves when the same tool runs twice in parallel (Tier 2's
// parallel read-only tools made that real).
let _toolCallSeq = 0;
const _origExecuteTool = toolsService.executeTool.bind(toolsService);
toolsService.executeTool = async function (name, args, dryRun = false, options = {}) {
  const src = (options && options.source) || '';
  const callId = `tc-${Date.now()}-${++_toolCallSeq}`;
  try { emitVoiceEvent('tool.start', { callId, tool: name, args: _safeToolArgs(args), dryRun }, src || 'agent'); } catch { /* ignore */ }
  let res;
  try {
    res = await _origExecuteTool(name, args, dryRun, options);
    return res;
  } finally {
    try {
      const inner = (res && res.result && typeof res.result === 'object') ? res.result : res;
      const ok = !(res && res.ok === false) && !(inner && inner.status === 'error');
      emitVoiceEvent('tool.result', {
        callId,
        tool: name,
        ok,
        status: (inner && inner.status) || (ok ? 'ok' : 'error'),
        summary: _summarizeToolResult(inner),
      }, src || 'agent');
    } catch { /* ignore */ }
  }
};
function _safeToolArgs(args) {
  try {
    if (args == null) return {};
    // Credential redaction (#21 review): web_automation gained a `login` action whose args
    // carry a plaintext password — tool.start events are broadcast to the UI and stored in
    // logs, so sensitive keys are masked HERE, at the single emit point.
    let masked = args;
    if (typeof args === 'object' && !Array.isArray(args)) {
      masked = {};
      for (const [k, v] of Object.entries(args)) {
        masked[k] = /pass|secret|token|api_?key|credential|auth/i.test(k) ? '•••' : v;
      }
    }
    const s = JSON.stringify(masked);
    return s.length > 240 ? (s.slice(0, 240) + '…') : masked;
  } catch { return {}; }
}
function _summarizeToolResult(r) {
  try {
    if (r == null) return '';
    if (typeof r !== 'object') return String(r).slice(0, 180);
    return String(r.message || r.summary || r.description || r.status || JSON.stringify(r)).slice(0, 200);
  } catch { return ''; }
}

// Warm up cache on module load with retry for Python worker
const warmupCache = async (retries = 3, delay = 5000) => {
  for (let i = 0; i < retries; i++) {
    await new Promise(r => setTimeout(r, delay));
    try {
      const tools = await toolsService.getAllTools(true);
      if (tools.length > 10) { // Expect Python tools
        logger.info('[tools] Initial cache warmed', { count: tools.length });
        return;
      }
      logger.info('[tools] Cache warm attempt', { attempt: i + 1, count: tools.length });
    } catch (e) {
      logger.warn('[tools] Cache warm attempt failed', { attempt: i + 1, error: e.message });
    }
  }
};
if (process.env.NODE_ENV !== 'test' && process.env.AVA_TOOL_WARMUP !== '0') warmupCache();

export default toolsService;
