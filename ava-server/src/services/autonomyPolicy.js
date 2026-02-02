import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

export class AutonomyPolicyError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'AutonomyPolicyError';
    this.details = details;
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function nowLocalHHMM(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function isWithinQuietHours(policy, date = new Date()) {
  const q = policy.quiet_hours;
  if (!q || !q.enabled) return false;
  const t = nowLocalHHMM(date);
  const start = q.start;
  const end = q.end;
  if (start <= end) return t >= start && t < end;
  return t >= start || t < end;
}

export function estimateUrgency({ triggerBase = 0, impact = 0, timeSensitivity = 0, confidence = 0, disruptionCost = 0 }) {
  const u = triggerBase + clamp(impact, 0, 4) + clamp(timeSensitivity, 0, 3) + clamp(confidence, 0, 2) + clamp(1 - clamp(disruptionCost, 0, 1), 0, 1);
  return clamp(Math.round(u * 10) / 10, 0, 10);
}

function pickBand(policy, urgency) {
  const bands = policy.decision_policy.urgency_bands;
  if (urgency >= bands.high.min) return { name: 'high', ...bands.high };
  if (urgency >= bands.medium.min) return { name: 'medium', ...bands.medium };
  return { name: 'low', ...bands.low };
}

function defaultOutcome(policy, urgency) {
  const band = pickBand(policy, urgency);
  return band.default_outcome;
}

function normalizeDomain(policy, domain) {
  if (!domain) return 'personal_assistant';
  return policy.domains[domain] ? domain : 'personal_assistant';
}

function normalizeTrigger(policy, trigger) {
  if (!trigger) return null;
  return policy.triggers[trigger] ? trigger : null;
}

class BudgetTracker {
  constructor(policy) {
    this.policy = policy;
    this.reset();
  }
  reset() {
    this.window = {
      dayKey: this._dayKey(),
      hourKey: this._hourKey(),
      daily: { actions: 0, notifications: 0, interrupts: 0, memoryWrites: 0, curiosityMinutes: 0, curiosityFindings: 0 },
      hourly: { actions: 0, notifications: 0, interrupts: 0, memoryWrites: 0 }
    };
  }
  _dayKey(d = new Date()) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  _hourKey(d = new Date()) {
    return `${this._dayKey(d)}T${String(d.getHours()).padStart(2, '0')}`;
  }
  _rollWindowsIfNeeded() {
    const dk = this._dayKey();
    const hk = this._hourKey();
    if (dk !== this.window.dayKey) {
      this.window.dayKey = dk;
      this.window.daily = { actions: 0, notifications: 0, interrupts: 0, memoryWrites: 0, curiosityMinutes: 0, curiosityFindings: 0 };
    }
    if (hk !== this.window.hourKey) {
      this.window.hourKey = hk;
      this.window.hourly = { actions: 0, notifications: 0, interrupts: 0, memoryWrites: 0 };
    }
  }
  canSpend(kind, amount = 1) {
    this._rollWindowsIfNeeded();
    const b = this.policy.budgets;
    const t = this.policy.thresholds;
    const dailyCap = {
      actions: b.daily.max_actions,
      notifications: b.daily.max_notifications,
      interrupts: b.daily.max_interrupts,
      memoryWrites: b.daily.max_memory_writes
    };
    const hourlyCap = {
      actions: b.hourly.max_actions,
      notifications: b.hourly.max_notifications,
      interrupts: b.hourly.max_interrupts,
      memoryWrites: b.hourly.max_memory_writes
    };
    if (kind === 'curiosityMinutes') {
      return (this.window.daily.curiosityMinutes + amount) <= t.curiosity_max_minutes_per_day;
    }
    if (kind === 'curiosityFindings') {
      return (this.window.daily.curiosityFindings + amount) <= t.curiosity_max_findings_per_day;
    }
    if (!dailyCap[kind] || !hourlyCap[kind]) return true;
    return (this.window.daily[kind] + amount) <= dailyCap[kind] && (this.window.hourly[kind] + amount) <= hourlyCap[kind];
  }
  spend(kind, amount = 1) {
    this._rollWindowsIfNeeded();
    if (kind === 'curiosityMinutes') this.window.daily.curiosityMinutes += amount;
    else if (kind === 'curiosityFindings') this.window.daily.curiosityFindings += amount;
    else {
      this.window.daily[kind] += amount;
      this.window.hourly[kind] += amount;
    }
  }
  snapshot() {
    this._rollWindowsIfNeeded();
    return JSON.parse(JSON.stringify(this.window));
  }
}

export class AutonomyPolicy {
  constructor({ policyPath, schemaPath, logger } = {}) {
    this.logger = logger || console;
    this.policyPath = policyPath || path.join(process.cwd(), 'policies', 'autonomy_policy.json');
    this.schemaPath = schemaPath || path.join(process.cwd(), 'policies', 'autonomy_policy.schema.json');
    this.policy = null;
    this.budgets = null;
  }
  load() {
    const policyRaw = fs.readFileSync(this.policyPath, 'utf8');
    const schemaRaw = fs.readFileSync(this.schemaPath, 'utf8');
    const policy = JSON.parse(policyRaw);
    const schema = JSON.parse(schemaRaw);
    // Try to load Ajv synchronously via createRequire (no network install needed during tests)
    let ajvCtor = null;
    try {
      const require = createRequire(import.meta.url);
      const mod = require('ajv');
      ajvCtor = (mod && mod.default) ? mod.default : mod;
    } catch {}
    const strict = process.env.NODE_ENV === 'production' || process.env.STRICT_POLICY === '1';
    if (ajvCtor) {
      const ajv = new ajvCtor({ allErrors: true, strict: true });
      const validate = ajv.compile(schema);
      const ok = validate(policy);
      if (!ok) {
        if (strict) {
          throw new AutonomyPolicyError('Autonomy policy validation failed', validate.errors);
        } else {
          this.logger.warn?.('[autonomyPolicy] SCHEMA VALIDATION FAILED (DEV FALLBACK ACTIVE)', { errors: validate.errors });
        }
      }
    } else {
      if (strict) {
        throw new AutonomyPolicyError('Ajv not available and STRICT_POLICY/production is set');
      }
      // Minimal fallback validation (DEV ONLY): check required top-level keys
      this.logger.warn?.('[autonomyPolicy] Ajv not available — DEV FALLBACK VALIDATOR IN USE');
      const required = ['version','policy_name','defaults','autonomy_levels','domains','triggers','thresholds','budgets','risk_policy','decision_policy'];
      for (const k of required) {
        if (!(k in policy)) {
          throw new AutonomyPolicyError(`Autonomy policy missing key: ${k}`);
        }
      }
    }
    this.policy = policy;
    this.strict = strict;
    this.validationMode = this.validationMode || (strict ? 'ajv_strict' : 'fallback_dev');
    this.budgets = new BudgetTracker(policy);
    this.logger.info?.(`[autonomyPolicy] Loaded and validated policy v${policy.version}: ${policy.policy_name}`);
    return policy;
  }
  getPolicy() {
    if (!this.policy) throw new AutonomyPolicyError('Policy not loaded');
    return this.policy;
  }
  getBudgets() {
    if (!this.budgets) throw new AutonomyPolicyError('Budgets not initialized');
    return this.budgets;
  }
  getStatus() {
    return {
      loaded: !!this.policy,
      validationMode: this.validationMode || (this.strict ? 'ajv_strict' : 'fallback_dev'),
      strict: !!this.strict,
      policyVersion: this.policy?.version ?? null,
      budgets: this.budgets?.snapshot?.() || null
    };
  }
  decide(input = {}) {
    const policy = this.getPolicy();
    const budgets = this.getBudgets();
    const domain = normalizeDomain(policy, input.domain);
    const trigger = normalizeTrigger(policy, input.trigger);
    const domainCfg = policy.domains[domain];
    const levelCfg = policy.autonomy_levels[String(domainCfg.autonomy_level)] || policy.autonomy_levels[String(policy.defaults.autonomy_level)];
    const allowTrigger = trigger ? domainCfg.allowed_triggers.includes(trigger) : input.isUserInitiated === true;
    if (!allowTrigger) {
      return this._result('do_nothing', { domain, trigger, reason: 'Trigger not allowed for domain' });
    }
    const base = trigger ? policy.triggers[trigger].urgency_base : 0;
    const s = input.signal || {};
    const urgency = estimateUrgency({
      triggerBase: base,
      impact: s.impact ?? 0,
      timeSensitivity: s.timeSensitivity ?? 0,
      confidence: s.confidence ?? 0,
      disruptionCost: s.disruptionCost ?? 0
    });
    const quiet = isWithinQuietHours(policy, new Date());
    const allowInterruptsNow = quiet ? (policy.quiet_hours?.during_quiet_hours?.allow_interrupts === true) : true;
    let outcome = defaultOutcome(policy, urgency);
    const wantsAct = (outcome === 'act' || outcome === 'act_then_report');
    if (wantsAct && !levelCfg.can_execute_tools) {
      outcome = urgency >= policy.thresholds.notify_urgency_threshold ? 'notify' : 'log_only';
    }
    if (trigger && policy.triggers[trigger].class === 'curiosity') {
      if (!policy.thresholds.curiosity_allowed) {
        return this._result('do_nothing', { domain, trigger, urgency, reason: 'Curiosity disabled' });
      }
      const relevance = s.relevanceScore ?? 0;
      if (relevance < policy.thresholds.curiosity_requires_relevance_score) {
        return this._result('log_only', { domain, trigger, urgency, relevance, reason: 'Curiosity relevance below threshold' });
      }
      if (!budgets.canSpend('curiosityMinutes', s.curiosityMinutes ?? policy.research_policy?.require_scope?.default_scope_minutes ?? 5)) {
        return this._result('log_only', { domain, trigger, urgency, reason: 'Curiosity minutes budget exceeded' });
      }
      if (!budgets.canSpend('curiosityFindings', 1)) {
        return this._result('log_only', { domain, trigger, urgency, reason: 'Curiosity findings budget exceeded' });
      }
      // Curiosity never interrupts. If user initiated, allow act_then_report; else notify/log_only only.
      outcome = isWithinQuietHours(policy, new Date()) ? 'log_only' : 'notify';
      if (input.isUserInitiated === true) {
        outcome = 'act_then_report';
      }
    }
    if (outcome === 'notify') {
      if (!budgets.canSpend('notifications', 1)) outcome = 'log_only';
    }
    if (outcome === 'ask_permission' && input.isUserInitiated === true) {
      if (!this._requiresApproval(input)) {
        outcome = 'act_then_report';
      }
    }
    if (this._requiresApproval(input)) {
      outcome = 'ask_permission';
    }
    const canInterrupt = allowInterruptsNow && urgency >= policy.thresholds.interrupt_urgency_threshold && budgets.canSpend('interrupts', 1);
    const canNotify = urgency >= policy.thresholds.notify_urgency_threshold && budgets.canSpend('notifications', 1);
    if (outcome === 'notify' && !canNotify) outcome = 'log_only';
    const ui = { canInterrupt, canNotify, quietHours: quiet };
    return this._result(outcome, { domain, trigger, urgency, ui, autonomyLevel: domainCfg.autonomy_level });
  }
  recordOutcome(outcome, meta = {}) {
    const budgets = this.getBudgets();
    if (outcome === 'act' || outcome === 'act_then_report') {
      if (budgets.canSpend('actions', 1)) budgets.spend('actions', 1);
    }
    if (outcome === 'notify') {
      if (budgets.canSpend('notifications', 1)) budgets.spend('notifications', 1);
    }
    if (meta.didInterrupt) {
      if (budgets.canSpend('interrupts', 1)) budgets.spend('interrupts', 1);
    }
    if (meta.memoryWrites) {
      if (budgets.canSpend('memoryWrites', meta.memoryWrites)) budgets.spend('memoryWrites', meta.memoryWrites);
    }
    if (meta.curiosityMinutes) {
      if (budgets.canSpend('curiosityMinutes', meta.curiosityMinutes)) budgets.spend('curiosityMinutes', meta.curiosityMinutes);
    }
    if (meta.curiosityFindings) {
      if (budgets.canSpend('curiosityFindings', meta.curiosityFindings)) budgets.spend('curiosityFindings', meta.curiosityFindings);
    }
  }
  shouldInterrupt(urgency) {
    const policy = this.getPolicy();
    const budgets = this.getBudgets();
    if (isWithinQuietHours(policy, new Date())) return false;
    return urgency >= policy.thresholds.interrupt_urgency_threshold && budgets.canSpend('interrupts', 1);
  }
  _requiresApproval(input) {
    const policy = this.getPolicy();
    const risk = input.risk || {};
    const requiresWrite = input.requiresWrite === true;
    if (requiresWrite && policy.defaults.require_user_approval_for.includes('any_write_operation')) return true;
    if (risk.toolRisk === 'high' && policy.risk_policy.high_risk_requires_approval) return true;
    if (risk.category && policy.risk_policy.high_risk_categories.includes(risk.category)) return true;
    if (risk.category && policy.defaults.require_user_approval_for.includes(risk.category)) return true;
    return false;
  }
  _result(outcome, details) {
    return { outcome, ...details, budgets: this.budgets?.snapshot?.() };
  }
}

let _autonomy = null;
export function getAutonomy(logger) {
  if (_autonomy) return _autonomy;
  const ap = new AutonomyPolicy({ logger });
  try { ap.load(); } catch (e) { (logger || console).warn?.('[autonomyPolicy] load failed', { error: e.message }); }
  _autonomy = ap;
  return _autonomy;
}

export default { AutonomyPolicy, AutonomyPolicyError, estimateUrgency, getAutonomy };
