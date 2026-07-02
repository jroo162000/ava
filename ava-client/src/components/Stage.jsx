import React, { useState, useEffect, useRef, useCallback, Suspense, lazy } from 'react';
import { publish, subscribe } from '../liveBus.js';
import ArtifactPanel from './ArtifactPanel.jsx';

// #17b: the holographic core is lazy — three.js loads in its own chunk, and any load
// failure just leaves the CSS orb (the Suspense fallback / degrade path) in place.
const Core3D = lazy(() => import('./Core3D.jsx'));

// ─────────────────────────────────────────────────────────────────────────────
// Stage — Tier 3 #16 (Phase 1 of the UI merge, docs/UI_MERGE_PLAN.md).
// A presence, not a chat log. Every panel renders REAL events from the one
// /voice/ws socket (Tier 2 #15): transcript.final / assistant.final /
// assistant.delta / agent.state / tool.start / tool.result / agent.activity /
// selfmod.pending / moltbook.verifications / self.theme / panel.
//
// Phase 1 scope (per plan §8): dark stage layout, conversation ticker, command
// line, unified panel dock (ToolTrace + orchestration cards), attention tray
// (approvals + verifications), CSS core placeholder driven by the real state
// machine. The 3D core (HolographicHead) and tts.level amplitude are Phase 2;
// sys.stats vitals and workflow cards are Phase 3. AVA's presenter cards stay
// on the proven ArtifactPanel overlay for now — folding them into the dock is
// Phase 2/3 work (the panel manager here is built to absorb them).
//
// ?classic=1 renders MinimalAVA instead (main.jsx) — never lose the escape hatch.
// ─────────────────────────────────────────────────────────────────────────────

const WS_URL = (() => {
  const env = import.meta?.env?.VITE_AVA_SERVER_URL;
  if (env && /^https?:/i.test(env)) {
    const base = env.replace(/^http/i, 'ws').replace(/\/$/, '');
    const tok = import.meta?.env?.VITE_AVA_WS_TOKEN;
    return `${base}/voice/ws${tok ? `?token=${encodeURIComponent(tok)}` : ''}`;
  }
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/voice/ws`;
})();
const API_BASE = (import.meta?.env?.VITE_AVA_SERVER_URL || '/api').replace(/\/$/, '');

// ---- tiny dark-mode markdown (escaped first; headings/bold/code/lists/links) ----
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function md(src) {
  let text = esc(src);
  const blocks = [];
  // fenced code -> ASCII sentinel line (cannot collide: '@' is escaped nowhere, digits only inside)
  text = text.replace(/```(?:[a-zA-Z0-9_+-]+)?\n?([\s\S]*?)```/g, (m, code) => {
    blocks.push(`<pre class="st-code"><code>${code.replace(/\n+$/, '')}</code></pre>`);
    return `\n@@BLK${blocks.length - 1}@@\n`;
  });
  text = text
    .replace(/`([^`]+)`/g, '<code class="st-icode">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const lines = text.split(/\n/);
  let html = '', list = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const line of lines) {
    if (/^@@BLK\d+@@$/.test(line.trim())) { closeList(); html += line.trim(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (h) { closeList(); html += `<div class="st-h">${h[2]}</div>`; continue; }
    if (ul) { if (list !== 'ul') { closeList(); html += '<ul class="st-ul">'; list = 'ul'; } html += `<li>${ul[1]}</li>`; continue; }
    if (ol) { if (list !== 'ol') { closeList(); html += '<ol class="st-ul">'; list = 'ol'; } html += `<li>${ol[1]}</li>`; continue; }
    closeList();
    if (line.trim() === '') continue;
    html += `<div class="st-p">${line}</div>`;
  }
  closeList();
  return html.replace(/@@BLK(\d+)@@/g, (m, i) => blocks[+i] || '');
}

const rid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const argHint = (a) => {
  try {
    if (!a) return '';
    if (a.query) return String(a.query);
    if (a.url) return String(a.url);
    if (a.path || a.file) return String(a.path || a.file);
    const k = Object.keys(a)[0];
    return k ? `${k}: ${String(a[k]).slice(0, 60)}` : '';
  } catch { return ''; }
};

// ─── unified panel dock (plan §4) — one store for every card kind ───────────
// card: { id, kind, title, detail, body, state: 'active'|'resolved', ok, pinned, ts, resolvedAt }
const MAX_VISIBLE = 6;
const RESOLVED_TTL_MS = 8000;
function usePanelDock() {
  const [cards, setCards] = useState([]);
  const spawn = useCallback((card) => {
    setCards(prev => {
      let next = [...prev, { state: 'active', pinned: false, ts: Date.now(), ...card, id: card.id || rid() }];
      // visibility cap: drop the oldest unpinned RESOLVED card first, never an active one
      while (next.length > MAX_VISIBLE) {
        const idx = next.findIndex(c => c.state === 'resolved' && !c.pinned);
        if (idx === -1) break;
        next = [...next.slice(0, idx), ...next.slice(idx + 1)];
      }
      return next;
    });
  }, []);
  const patchWhere = useCallback((pred, p) => {
    setCards(prev => {
      // newest matching card wins (parallel same-name tools resolve most-recent-first
      // until the server's callId pairing lands in Phase 2)
      for (let i = prev.length - 1; i >= 0; i--) {
        if (pred(prev[i])) {
          const copy = prev.slice();
          copy[i] = { ...prev[i], ...(typeof p === 'function' ? p(prev[i]) : p) };
          return copy;
        }
      }
      return prev;
    });
  }, []);
  const dismiss = useCallback((id) => setCards(prev => prev.filter(c => c.id !== id)), []);
  const togglePin = useCallback((id) => setCards(prev => prev.map(c => (c.id === id ? { ...c, pinned: !c.pinned } : c))), []);
  // sweep: resolved unpinned cards auto-dismiss after their TTL
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setCards(prev => {
        const next = prev.filter(c => !(c.state === 'resolved' && !c.pinned && c.resolvedAt && now - c.resolvedAt > (c.ttl || RESOLVED_TTL_MS)));
        return next.length === prev.length ? prev : next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);
  return { cards, spawn, patchWhere, dismiss, togglePin };
}

// ─── core state machine (plan §5, Phase 1 signals only — all real) ──────────
// idle → thinking (user turn landed) → speaking (deltas/final) → idle
//                 ↘ working (agent.state working.start/end, parallel)
// ATTENTION is an overlay flag from the attention tray, not a state.
function useCoreState() {
  const [state, setState] = useState('idle');       // idle | thinking | speaking | working
  const [caption, setCaption] = useState('');
  const speakIdle = useRef(null);
  const workGuard = useRef(null);
  const workingRef = useRef(false);
  const set = useCallback((s, cap) => { setState(s); if (cap !== undefined) setCaption(cap); }, []);
  const onUserTurn = useCallback(() => set('thinking', ''), [set]);
  const onDelta = useCallback(() => {
    clearTimeout(speakIdle.current);
    set('speaking');
    speakIdle.current = setTimeout(() => set(workingRef.current ? 'working' : 'idle'), 3000);
  }, [set]);
  const onFinal = useCallback(() => {
    clearTimeout(speakIdle.current);
    set('speaking');
    speakIdle.current = setTimeout(() => set(workingRef.current ? 'working' : 'idle', ''), 2500);
  }, [set]);
  const onWorking = useCallback((on, goal) => {
    workingRef.current = on;
    clearTimeout(workGuard.current);
    if (on) {
      set('working', goal || '');
      // crash failsafe only — working.end is the real signal (Tier 2 #15)
      workGuard.current = setTimeout(() => { workingRef.current = false; set('idle', ''); }, 180000);
    } else {
      workGuard.current = setTimeout(() => set('idle', ''), 1200);
    }
  }, [set]);
  // #17: REAL audio drives SPEAKING — tts.level rms from the voice runner while Piper plays.
  const onAudio = useCallback((rms) => {
    if ((rms | 0) <= 60) return;                 // silence / settle frames don't flip state
    clearTimeout(speakIdle.current);
    set('speaking');
    speakIdle.current = setTimeout(() => set(workingRef.current ? 'working' : 'idle'), 1200);
  }, [set]);
  return { state, caption, onUserTurn, onDelta, onFinal, onWorking, onAudio };
}

// ─── diff renderer (ported from MinimalAVA — real hunks, colored) ───────────
function Diff({ text }) {
  return (
    <pre className="st-diff">
      {String(text).split('\n').map((ln, i) => (
        <div key={i} style={{ color: ln.startsWith('+') && !ln.startsWith('+++') ? '#86efac' : ln.startsWith('-') && !ln.startsWith('---') ? '#fca5a5' : ln.startsWith('@@') ? '#93c5fd' : '#8b93a7' }}>{ln || ' '}</div>
      ))}
    </pre>
  );
}

export default function Stage() {
  const [connected, setConnected] = useState(false);
  const [turns, setTurns] = useState([]);            // {id, who:'user'|'ava', text, ts, via}
  const [liveText, setLiveText] = useState('');      // assistant.delta accumulator
  const [historyOpen, setHistoryOpen] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [pendingMods, setPendingMods] = useState([]);
  const [pendingVerifs, setPendingVerifs] = useState([]);
  const [verifAnswers, setVerifAnswers] = useState({});
  const [verifError, setVerifError] = useState('');
  const [busyId, setBusyId] = useState('');
  const actedMods = useRef(new Set());
  const submittedVerifs = useRef(new Set());
  const sendInFlight = useRef(false);
  const dock = usePanelDock();
  const core = useCoreState();
  const orchId = useRef(null);                       // current orchestration card id
  const [amp, setAmp] = useState(0);                 // #17: live speech amplitude (rms)
  const ampDecay = useRef(null);
  const ampRef = useRef(0);                          // #17b: ref mirror for the 3D core (no re-render churn)
  const stateRef = useRef('idle');
  const [degraded3d, setDegraded3d] = useState(false); // #17b: auto-degrade -> CSS orb

  const attention = pendingMods.length + pendingVerifs.length;

  // ---- echo dedupe for typed turns (WS mirrors them back) ----
  const recentKeys = useRef(new Map());
  const keyOf = (who, text) => `${who}|${String(text || '').trim().slice(0, 140)}`;
  const noteKey = (who, text) => recentKeys.current.set(keyOf(who, text), Date.now());
  const isDup = (who, text) => {
    const t = recentKeys.current.get(keyOf(who, text));
    return t && Date.now() - t < 12000;
  };
  const addTurn = useCallback((who, text, via) => {
    if (!text || !String(text).trim()) return;
    if (isDup(who, text)) return;
    noteKey(who, text);
    setTurns(prev => [...prev.slice(-199), { id: rid(), who, text: String(text), ts: Date.now(), via }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- her theme (self_express) mapped onto the stage variables ----
  useEffect(() => {
    let alive = true;
    const apply = (t) => {
      if (!alive || !t) return;
      const root = document.documentElement;
      for (const [k, v] of Object.entries(t)) root.style.setProperty(`--ava-${k}`, v);
    };
    const fetchTheme = async () => {
      try { const r = await fetch(`${API_BASE}/self/theme`); const j = await r.json(); apply(j && j.theme); } catch { /* defaults */ }
    };
    fetchTheme();
    const un = subscribe((ev) => {
      if (ev.type === 'self.theme') apply(ev.data && ev.data.theme);
      else if (ev.type === 'ws.open') fetchTheme();
    });
    return () => { alive = false; un(); };
  }, []);

  // ---- THE socket (Stage owns it in this mode; fans out via liveBus) ----
  useEffect(() => {
    let ws, retry, closed = false;
    const handleEvent = (ev) => {
      if (!ev || !ev.type) return;
      const d = ev.data || {};
      switch (ev.type) {
        case 'transcript.final':
          addTurn('user', d.text, ev.source === 'voice' ? 'voice' : undefined);
          core.onUserTurn();
          break;
        case 'assistant.delta':
          setLiveText(prev => prev + String(d.text || ''));
          core.onDelta();
          break;
        case 'assistant.final':
          addTurn('ava', d.text);
          setLiveText('');
          core.onFinal();
          break;
        case 'agent.state':
          if (d.state === 'working.start') core.onWorking(true, d.goal);
          else if (d.state === 'working.end') core.onWorking(false);
          break;
        case 'tts.level': {
          // #17: real amplitude from the voice runner — the core pulses to HER voice.
          const rms = (d && d.rms) | 0;
          setAmp(rms);
          ampRef.current = rms;
          core.onAudio(rms);
          clearTimeout(ampDecay.current);
          ampDecay.current = setTimeout(() => { setAmp(0); ampRef.current = 0; }, 450);  // no frames -> settle
          break;
        }
        case 'tool.start':
          dock.spawn({ kind: 'tool', callId: d.callId || '', title: d.tool || 'tool', detail: argHint(d.args), state: 'active' });
          break;
        case 'tool.result':
          dock.patchWhere(
            // #17: exact pairing by callId (server tags both events); name match is the
            // fallback for events emitted before the server upgrade.
            (c) => c.kind === 'tool' && c.state === 'active'
              && (d.callId ? c.callId === d.callId : c.title === (d.tool || 'tool')),
            { state: 'resolved', ok: !!d.ok, detail: String(d.summary || d.status || (d.ok ? 'done' : 'failed')).slice(0, 180), resolvedAt: Date.now() }
          );
          break;
        case 'agent.activity': {
          const phase = d.phase || 'step';
          if (phase === 'delegate') {
            const id = rid();
            orchId.current = id;
            dock.spawn({ id, kind: 'orch', title: 'Orchestration', detail: d.label || '', body: { nodes: [] }, state: 'active' });
          }
          if (orchId.current) {
            const oid = orchId.current;
            dock.patchWhere((c) => c.id === oid, (c) => {
              const nodes = [...((c.body && c.body.nodes) || [])];
              if (phase === 'subagent_start') nodes.push({ id: rid(), label: d.label || 'subagent', detail: d.detail || '', state: 'running' });
              else if (phase === 'subagent_done') {
                const i = nodes.findIndex(n => n.state === 'running');
                if (i >= 0) nodes[i] = { ...nodes[i], state: 'done' };
              } else if (phase === 'synthesize') nodes.push({ id: rid(), label: 'Synthesizing…', detail: d.detail || '', state: 'synth' });
              const done = phase === 'done';
              return { body: { nodes }, detail: d.label || c.detail, state: done ? 'resolved' : 'active', ok: done ? true : c.ok, resolvedAt: done ? Date.now() : c.resolvedAt, ttl: 6000 };
            });
            if (phase === 'done') orchId.current = null;
          }
          break;
        }
        default: break;
      }
    };
    const connect = () => {
      try { ws = new WebSocket(WS_URL); } catch { retry = setTimeout(connect, 3000); return; }
      ws.onopen = () => { setConnected(true); publish({ type: 'ws.open' }); };
      ws.onclose = () => { setConnected(false); if (!closed) retry = setTimeout(connect, 3000); };
      ws.onerror = () => { try { ws.close(); } catch { /* */ } };
      ws.onmessage = (e) => {
        let ev = null;
        try { ev = JSON.parse(e.data); } catch { /* */ }
        if (!ev) return;
        if (import.meta.env.DEV) {
          if (ev.type === 'tts.level') {
            // log arrival evidence without flooding: first frame + every 40th
            window.__ttsN = (window.__ttsN || 0) + 1;
            if (window.__ttsN === 1 || window.__ttsN % 40 === 0) console.log('[stage-ev] tts.level n=' + window.__ttsN + ' rms=' + ((ev.data || {}).rms | 0));
          } else {
            console.log('[stage-ev]', ev.type, ev.source || '');
          }
        }
        try { handleEvent(ev); } catch (err) { console.error('[stage-ev] handler', err); }
        publish(ev);   // theme / presenter / any other subscriber
      };
    };
    connect();
    return () => { closed = true; clearTimeout(retry); try { ws && ws.close(); } catch { /* */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- self-mod approvals (event-driven + snapshot, Tier 2 #15 pattern) ----
  useEffect(() => {
    let stop = false;
    const applyList = (list) => {
      if (stop) return;
      setPendingMods(Array.isArray(list) ? list.filter(m => (m.status || 'pending') === 'pending' && !actedMods.current.has(m.id)) : []);
    };
    const fetchPending = async () => {
      try {
        const r = await fetch(`${API_BASE}/self_mod`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'list_pending' }) });
        const j = await r.json().catch(() => ({}));
        applyList((j && (j.pending || j.modifications)) || []);
      } catch { /* restarting */ }
    };
    fetchPending();
    const un = subscribe((ev) => {
      if (ev.type === 'selfmod.pending') applyList((ev.data && ev.data.pending) || []);
      else if (ev.type === 'ws.open') fetchPending();
    });
    return () => { stop = true; un(); };
  }, []);

  const actOnMod = async (id, action) => {
    setBusyId(id);
    actedMods.current.add(id);
    setPendingMods(prev => prev.filter(m => m.id !== id));
    try {
      await fetch(`${API_BASE}/self_mod`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, modification_id: id }) });
    } catch { /* reconciles via events */ } finally { setBusyId(''); }
  };

  // ---- Moltbook verifications ----
  useEffect(() => {
    let stop = false;
    const applyPending = (pending) => {
      if (stop) return;
      const list = Array.isArray(pending) ? pending : [];
      setPendingVerifs(list.filter(v => !submittedVerifs.current.has(v.verification_code)));
    };
    const fetchVerifs = async () => {
      try { const r = await fetch(`${API_BASE}/moltbook/verifications`).then(x => x.json()); applyPending(r && r.pending); } catch { /* */ }
    };
    fetchVerifs();
    const un = subscribe((ev) => {
      if (ev.type === 'moltbook.verifications') applyPending(ev.data && ev.data.pending);
      else if (ev.type === 'ws.open') fetchVerifs();
    });
    return () => { stop = true; un(); };
  }, []);

  const submitVerif = async (code) => {
    const answer = (verifAnswers[code] || '').trim();
    if (!answer) return;
    const current = pendingVerifs.find(v => v.verification_code === code);
    setBusyId(code);
    setVerifError('');
    submittedVerifs.current.add(code);
    setPendingVerifs(prev => prev.filter(v => v.verification_code !== code));
    try {
      const r = await fetch(`${API_BASE}/moltbook/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, answer }) }).then(x => x.json()).catch(() => ({}));
      if (r && (r.ok || r.cleared)) {
        setVerifAnswers(a => { const n = { ...a }; delete n[code]; return n; });
      } else {
        submittedVerifs.current.delete(code);
        if (current) setPendingVerifs(prev => (prev.some(v => v.verification_code === code) ? prev : [current, ...prev]));
        setVerifError(r?.error || r?.result?.error || 'Moltbook did not accept that answer.');
      }
    } catch {
      submittedVerifs.current.delete(code);
      if (current) setPendingVerifs(prev => (prev.some(v => v.verification_code === code) ? prev : [current, ...prev]));
      setVerifError('Could not reach the AVA server.');
    } finally { setBusyId(''); }
  };

  // ---- command line (plan §9: NO client-side intent regex — the server routes) ----
  const send = async () => {
    const text = input.trim();
    if (!text || sendInFlight.current) return;
    sendInFlight.current = true;
    setSending(true);
    addTurn('user', text);
    core.onUserTurn();
    setInput('');
    try {
      const r = await fetch(`${API_BASE}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, session_id: 'stage' }) });
      const data = await r.json().catch(() => ({}));
      if (!data?.duplicate_suppressed) {
        const botText = data.message || data.text || "Sorry, I couldn't process that.";
        addTurn('ava', botText);
        core.onFinal();
      }
    } catch (e) {
      addTurn('ava', `Error: ${e.message}`);
    } finally {
      sendInFlight.current = false;
      setSending(false);
    }
  };

  const ticker = turns.slice(-6);
  const coreState = core.state;
  stateRef.current = coreState;   // ref mirror for the 3D core's frame loop
  const stateLabel = { idle: 'idle', thinking: 'thinking…', speaking: 'speaking', working: 'working…' }[coreState] || '';

  const cssCore = (
    <div className={`st-core ${coreState} ${attention ? 'attention' : ''}`}>
      <div className="st-ring r1" /><div className="st-ring r2" /><div className="st-ring r3" />
      <div className="st-orb" style={amp > 0 ? { transform: `scale(${1 + Math.min(amp / 9000, 0.55)})`, transition: 'transform 90ms linear', animation: 'none' } : undefined} />
    </div>
  );

  return (
    <div className={`stage ${attention ? 'attn' : ''}`}>
      <style>{STAGE_CSS}</style>

      {/* top strip: connection + state (vitals arrive in Phase 3) */}
      <div className="st-top">
        <span className={`st-dot ${connected ? 'on' : ''}`} />
        <span className="st-topline">{connected ? 'live' : 'connecting…'}</span>
        <span className="st-topstate">{stateLabel}{coreState === 'working' && core.caption ? ` — ${core.caption}` : ''}</span>
        <button className="st-ghost" onClick={() => setHistoryOpen(o => !o)} title="Toggle full history">{historyOpen ? 'close history' : 'history'}</button>
        <a className="st-ghost" href="?classic=1" title="Classic UI fallback">classic</a>
      </div>

      {/* left: conversation ticker (fades with age) */}
      <div className="st-ticker">
        {ticker.map((t, i) => (
          <div key={t.id} className={`st-turn ${t.who}`} style={{ opacity: 0.35 + 0.65 * ((i + 1) / ticker.length) }}>
            <span className="st-who">{t.who === 'user' ? 'you' : 'ava'}{t.via === 'voice' ? ' ·voice' : ''}</span>
            {t.who === 'ava'
              ? <div className="st-md" dangerouslySetInnerHTML={{ __html: md(t.text) }} />
              : <div className="st-md st-user">{t.text}</div>}
          </div>
        ))}
        {liveText && (
          <div className="st-turn ava live">
            <span className="st-who">ava · speaking</span>
            <div className="st-md" dangerouslySetInnerHTML={{ __html: md(liveText) }} />
          </div>
        )}
        {sending && !liveText && <div className="st-turn ava live"><span className="st-who">ava</span><div className="st-md st-thinking">…</div></div>}
      </div>

      {/* center: the core — state machine is real; motion/pulse is HER live amplitude (#17).
          3D holographic core (#17b) with the CSS orb as Suspense fallback + degrade path. */}
      <div className="st-corewrap">
        {degraded3d ? cssCore : (
          <div className={`st-core3d ${attention ? 'attention' : ''}`}>
            <Suspense fallback={cssCore}>
              <Core3D stateRef={stateRef} ampRef={ampRef} onDegrade={(why) => { console.warn('[stage] 3D core degraded:', why); setDegraded3d(true); }} />
            </Suspense>
          </div>
        )}
      </div>

      {/* right: unified panel dock — ToolTrace + orchestration cards */}
      <div className="st-dock">
        {dock.cards.map((c) => (
          <div key={c.id} className={`st-card ${c.state} ${c.kind}`}>
            <div className="st-cardhead">
              <span className={`st-cdot ${c.state === 'active' ? 'run' : c.ok ? 'ok' : 'err'}`} />
              <span className="st-ctitle">{c.title}</span>
              <button className="st-ghost" onClick={() => dock.togglePin(c.id)} title={c.pinned ? 'unpin' : 'pin'}>{c.pinned ? '📌' : '·'}</button>
              <button className="st-ghost" onClick={() => dock.dismiss(c.id)} title="dismiss">✕</button>
            </div>
            {c.detail ? <div className="st-cdetail">{c.detail}</div> : null}
            {c.kind === 'orch' && c.body && c.body.nodes && c.body.nodes.length > 0 && (
              <div className="st-orch">
                {c.body.nodes.map(n => (
                  <div key={n.id} className={`st-node ${n.state}`}>
                    <span className="st-nodeicon">{n.state === 'running' ? '◌' : n.state === 'done' ? '●' : '◍'}</span>
                    <span className="st-nodelabel">{n.label}</span>
                    {n.detail ? <span className="st-nodedetail">{n.detail}</span> : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* bottom-left: attention tray (never auto-dismisses; drives core ATTENTION) */}
      {(pendingMods.length > 0 || pendingVerifs.length > 0) && (
        <div className="st-tray">
          {pendingMods.map((m) => {
            const fname = String(m.file || '').split(/[\\/]/).pop();
            const rec = m.review_recommendation || m.reviewRecommendation || m.metadata?.reviewRecommendation;
            const recReason = m.review_reason || m.reviewReason || m.metadata?.reviewReason;
            return (
              <div key={m.id} className="st-attn">
                <div className="st-attnhead">🛠 <span className="st-mono">{fname}</span> <span className="st-dim">#{m.id}</span></div>
                {m.reason && <div className="st-attnreason">{m.reason}</div>}
                {rec && <div className={`st-rec ${rec}`}>reviewer: {String(rec).toUpperCase()}{recReason ? ` — ${recReason}` : ''}</div>}
                {m.diff && <Diff text={m.diff} />}
                <div className="st-btnrow">
                  <button className="st-btn ok" disabled={busyId === m.id} onClick={() => actOnMod(m.id, 'approve')}>{busyId === m.id ? '…' : 'Approve & apply'}</button>
                  <button className="st-btn no" disabled={busyId === m.id} onClick={() => actOnMod(m.id, 'reject')}>Reject</button>
                </div>
              </div>
            );
          })}
          {pendingVerifs.map((v) => (
            <div key={v.verification_code} className="st-attn">
              <div className="st-attnhead">🔐 Moltbook verification <span className="st-dim">{v.title || ''}</span></div>
              <div className="st-attnreason">{v.challenge_text}</div>
              <div className="st-btnrow">
                <input className="st-vinput" value={verifAnswers[v.verification_code] || ''}
                  onChange={(e) => setVerifAnswers(a => ({ ...a, [v.verification_code]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitVerif(v.verification_code); }}
                  placeholder="answer" />
                <button className="st-btn ok" disabled={busyId === v.verification_code || !(verifAnswers[v.verification_code] || '').trim()}
                  onClick={() => submitVerif(v.verification_code)}>{busyId === v.verification_code ? '…' : 'Verify'}</button>
              </div>
              {verifError && <div className="st-verr">{verifError}</div>}
            </div>
          ))}
        </div>
      )}

      {/* bottom: command line */}
      <div className="st-cmdwrap">
        <span className="st-prompt">▸</span>
        <input
          className="st-cmd"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}
          placeholder="speak, or type…"
          disabled={sending}
        />
      </div>

      {/* full history overlay (on demand — the ticker is the default view) */}
      {historyOpen && (
        <div className="st-history" onClick={() => setHistoryOpen(false)}>
          <div className="st-historybox" onClick={(e) => e.stopPropagation()}>
            {turns.map(t => (
              <div key={t.id} className={`st-turn ${t.who}`}>
                <span className="st-who">{t.who === 'user' ? 'you' : 'ava'} · {new Date(t.ts).toLocaleTimeString()}</span>
                {t.who === 'ava'
                  ? <div className="st-md" dangerouslySetInnerHTML={{ __html: md(t.text) }} />
                  : <div className="st-md st-user">{t.text}</div>}
              </div>
            ))}
            {turns.length === 0 && <div className="st-dim" style={{ padding: 20 }}>No turns yet this session.</div>}
          </div>
        </div>
      )}

      {/* AVA's presenter — proven overlay, absorbed into the dock in Phase 2/3 */}
      <ArtifactPanel />
    </div>
  );
}

const STAGE_CSS = `
:root { --ava-accent: #8b5cf6; --ava-accent2: #22d3ee; }
html, body, #root { height: 100%; margin: 0; }
body { background: #000204; }
.stage { position: fixed; inset: 0; background: radial-gradient(1200px 700px at 50% 42%, #050a14 0%, #000204 70%); color: #cbd5e1; font-family: Inter, system-ui, sans-serif; overflow: hidden; }

.st-top { position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: center; gap: 10px; padding: 10px 16px; font-size: 12px; color: #64748b; z-index: 30; }
.st-dot { width: 8px; height: 8px; border-radius: 50%; background: #475569; }
.st-dot.on { background: #34d399; box-shadow: 0 0 8px #34d399; }
.st-topstate { color: var(--ava-accent); font-family: ui-monospace, monospace; }
.st-top .st-ghost { margin-left: auto; }
.st-top .st-ghost + .st-ghost { margin-left: 0; }
.st-ghost { background: transparent; border: 1px solid rgba(255,255,255,0.1); color: #64748b; border-radius: 7px; padding: 2px 9px; font-size: 11px; cursor: pointer; text-decoration: none; }
.st-ghost:hover { color: #cbd5e1; border-color: rgba(255,255,255,0.25); }

.st-ticker { position: absolute; left: 20px; top: 48px; bottom: 120px; width: min(34vw, 460px); display: flex; flex-direction: column; justify-content: flex-end; gap: 10px; z-index: 10; overflow: hidden; }
.st-turn { animation: stIn 220ms cubic-bezier(.2,.9,.3,1.2); }
.st-turn .st-who { display: block; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: #475569; margin-bottom: 2px; }
.st-turn.user .st-who { color: #64748b; }
.st-turn.ava .st-who { color: var(--ava-accent); }
.st-md { font-size: 13.5px; line-height: 1.55; color: #cbd5e1; word-wrap: break-word; }
.st-md.st-user { color: #94a3b8; }
.st-md a { color: var(--ava-accent2); }
.st-md .st-h { font-weight: 700; margin: 4px 0 2px; color: #e2e8f0; }
.st-md .st-ul { margin: 3px 0 3px 18px; padding: 0; }
.st-md .st-p { margin: 2px 0; }
.st-code { background: #0b1021; border: 1px solid #131a2e; border-radius: 8px; padding: 8px 10px; overflow: auto; font-size: 12px; line-height: 1.45; }
.st-icode { background: rgba(255,255,255,0.07); padding: 0 4px; border-radius: 4px; font-size: 0.9em; }
.st-thinking { color: #475569; font-size: 20px; letter-spacing: 4px; animation: stPulse 1.2s ease-in-out infinite; }
.st-turn.live .st-md::after { content: '▍'; color: var(--ava-accent); animation: stPulse 0.9s ease-in-out infinite; }

.st-corewrap { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 1; }
.st-core { position: relative; width: 240px; height: 240px; display: flex; align-items: center; justify-content: center; }
.st-orb { width: 64px; height: 64px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, var(--ava-accent2), var(--ava-accent) 60%, #1e1b4b 100%); box-shadow: 0 0 40px rgba(139,92,246,0.45); transition: box-shadow 400ms ease, transform 400ms ease; }
.st-ring { position: absolute; border-radius: 50%; border: 1px solid rgba(139,92,246,0.25); }
.st-ring.r1 { width: 120px; height: 120px; animation: stSpin 14s linear infinite; border-top-color: rgba(139,92,246,0.7); }
.st-ring.r2 { width: 170px; height: 170px; animation: stSpin 22s linear infinite reverse; border-bottom-color: rgba(34,211,238,0.5); }
.st-ring.r3 { width: 220px; height: 220px; animation: stSpin 34s linear infinite; border-left-color: rgba(139,92,246,0.35); }
.st-core.idle .st-orb { animation: stBreathe 5s ease-in-out infinite; }
.st-core.thinking .st-orb { animation: stBreathe 1.1s ease-in-out infinite; box-shadow: 0 0 55px rgba(139,92,246,0.75); }
.st-core.thinking .st-ring { animation-duration: 3s; }
.st-core.speaking .st-orb { animation: stSpeak 0.55s ease-in-out infinite; box-shadow: 0 0 70px rgba(34,211,238,0.65); }
.st-core.working .st-orb { box-shadow: 0 0 55px rgba(251,146,60,0.55); }
.st-core.working .st-ring { border-top-color: rgba(251,146,60,0.8); animation-duration: 2.2s; }
.st-core.attention::after { content: ''; position: absolute; inset: -14px; border-radius: 50%; border: 2px solid rgba(245,158,11,0.55); animation: stAttn 2.4s ease-in-out infinite; }
.st-core3d { position: relative; width: min(46vh, 480px); height: min(46vh, 480px); }
.st-core3d.attention::after { content: ''; position: absolute; inset: 18%; border-radius: 50%; border: 2px solid rgba(245,158,11,0.55); animation: stAttn 2.4s ease-in-out infinite; pointer-events: none; }

.st-dock { position: absolute; right: 16px; top: 48px; width: 330px; max-height: calc(100vh - 190px); display: flex; flex-direction: column; gap: 8px; z-index: 20; overflow-y: auto; }
.st-card { background: rgba(10,14,26,0.92); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 8px 10px; animation: stIn 200ms cubic-bezier(.2,.9,.3,1.2); backdrop-filter: blur(6px); }
.st-card.resolved { opacity: 0.75; }
.st-cardhead { display: flex; align-items: center; gap: 7px; }
.st-cdot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.st-cdot.run { background: var(--ava-accent); animation: stPulse 1s ease-in-out infinite; }
.st-cdot.ok { background: #34d399; }
.st-cdot.err { background: #f87171; }
.st-ctitle { font-family: ui-monospace, monospace; font-size: 12.5px; font-weight: 600; color: #e2e8f0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-cdetail { font-size: 11.5px; color: #7c869c; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-orch { margin-top: 6px; display: flex; flex-direction: column; gap: 3px; }
.st-node { display: flex; gap: 6px; align-items: baseline; font-size: 11.5px; }
.st-node.running .st-nodeicon { color: var(--ava-accent); animation: stPulse 1s ease-in-out infinite; }
.st-node.done .st-nodeicon { color: #34d399; }
.st-node.synth .st-nodeicon { color: var(--ava-accent2); }
.st-nodelabel { color: #cbd5e1; }
.st-nodedetail { color: #5b6577; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.st-tray { position: absolute; left: 20px; bottom: 86px; width: min(38vw, 520px); max-height: 46vh; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; z-index: 25; }
.st-attn { background: rgba(20,15,3,0.94); border: 1px solid rgba(245,158,11,0.4); border-radius: 12px; padding: 10px 12px; animation: stIn 220ms ease; }
.st-attnhead { font-size: 12.5px; font-weight: 700; color: #fbbf24; display: flex; gap: 6px; align-items: baseline; }
.st-attnreason { font-size: 12px; color: #cbd5e1; margin: 5px 0; }
.st-rec { font-size: 11px; border-radius: 6px; padding: 4px 7px; margin: 4px 0; background: rgba(255,255,255,0.05); color: #94a3b8; }
.st-rec.approve { color: #86efac; background: rgba(22,101,52,0.25); }
.st-rec.deny { color: #fca5a5; background: rgba(153,27,27,0.25); }
.st-diff { margin: 6px 0 0; max-height: 180px; overflow: auto; background: #0b1021; border-radius: 8px; padding: 8px 10px; font-size: 11px; line-height: 1.45; white-space: pre-wrap; }
.st-btnrow { display: flex; gap: 7px; margin-top: 8px; }
.st-btn { border: none; border-radius: 8px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; }
.st-btn.ok { background: #16a34a; color: white; }
.st-btn.no { background: transparent; color: #fca5a5; border: 1px solid rgba(252,165,165,0.4); }
.st-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.st-vinput { flex: 1; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; color: #e2e8f0; padding: 6px 10px; font-size: 12.5px; outline: none; }
.st-verr { color: #fca5a5; font-size: 11.5px; margin-top: 5px; }
.st-mono { font-family: ui-monospace, monospace; }
.st-dim { color: #5b6577; font-weight: 400; font-size: 11px; }

.st-cmdwrap { position: absolute; left: 50%; transform: translateX(-50%); bottom: 26px; width: min(720px, 86vw); display: flex; align-items: center; gap: 10px; background: rgba(10,14,26,0.9); border: 1px solid rgba(139,92,246,0.3); border-radius: 14px; padding: 12px 16px; z-index: 30; backdrop-filter: blur(8px); }
.st-prompt { color: var(--ava-accent); font-family: ui-monospace, monospace; }
.st-cmd { flex: 1; background: transparent; border: none; outline: none; color: #e2e8f0; font-family: ui-monospace, monospace; font-size: 14px; }
.st-cmd::placeholder { color: #475569; }

.st-history { position: fixed; inset: 0; background: rgba(0,2,4,0.8); z-index: 60; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px); }
.st-historybox { width: min(760px, 92vw); height: min(80vh, 900px); overflow-y: auto; background: rgba(8,12,22,0.98); border: 1px solid rgba(139,92,246,0.35); border-radius: 16px; padding: 18px 22px; display: flex; flex-direction: column; gap: 12px; }

@keyframes stIn { from { transform: scale(0.94) translateY(6px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes stPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@keyframes stSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes stBreathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.07); } }
@keyframes stSpeak { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.16); } }
@keyframes stAttn { 0%, 100% { opacity: 0.15; transform: scale(1); } 50% { opacity: 0.9; transform: scale(1.05); } }
`;
