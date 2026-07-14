import React, { useState, useEffect, useRef, useCallback } from 'react';
import { publish, subscribe } from './liveBus.js';

const API_BASE = (import.meta?.env?.VITE_AVA_SERVER_URL || '/api').replace(/\/$/, '');
const keyOf = (type, text) => `${type}|${String(text || '').trim().slice(0, 140)}`;

// Resolve the live-event WebSocket URL. Default: same-origin /voice/ws, which the Vite
// dev proxy upgrades + forwards to the AVA server WITH the API token injected server-side
// (Tier 0 security — the token never reaches the browser). Setting VITE_AVA_SERVER_URL
// connects directly instead, which requires VITE_AVA_WS_TOKEN (?token=) to authenticate.
const WS_URL = (() => {
  const env = import.meta?.env?.VITE_AVA_SERVER_URL;
  if (env && /^https?:/i.test(env)) {
    const base = env.replace(/^http/i, 'ws').replace(/\/$/, '');
    const tok = import.meta?.env?.VITE_AVA_WS_TOKEN;
    return `${base}/voice/ws${tok ? `?token=${encodeURIComponent(tok)}` : ''}`;
  }
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/voice/ws`;
})();

// Minimal, dependency-free Markdown -> HTML so AVA's replies render with real formatting
// (headings, bold/italics, lists, code) like a frontier assistant. HTML is escaped first.
const _escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderMarkdown(src) {
  let text = _escapeHtml(src);
  const blocks = [];
  // fenced code blocks -> placeholder, restored last
  text = text.replace(/```(?:[a-zA-Z0-9_+-]+)?\n?([\s\S]*?)```/g, (m, code) => {
    blocks.push(`<pre style="background:#0b1021;color:#e5e7eb;border-radius:.5rem;padding:.7rem .8rem;overflow:auto;font-size:.8rem;line-height:1.45;margin:.5rem 0"><code>${code.replace(/\n+$/,'')}</code></pre>`);
    return `@@AVA_BLOCK_${blocks.length - 1}@@`;
  });
  // inline spans
  text = text
    .replace(/`([^`]+)`/g, '<code style="background:rgba(0,0,0,0.06);padding:.05rem .3rem;border-radius:.25rem;font-size:.85em">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // block layout: headings, lists, paragraphs
  const lines = text.split(/\n/);
  let html = '', listType = null;
  const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
  for (const line of lines) {
    if (/^@@AVA_BLOCK_\d+@@$/.test(line.trim())) { closeList(); html += line.trim(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (h) { closeList(); const lvl = h[1].length; const sz = [0, 1.25, 1.15, 1.05, 1, 0.95, 0.9][lvl]; html += `<div style="font-weight:700;font-size:${sz}rem;margin:.6rem 0 .3rem">${h[2]}</div>`; continue; }
    if (ul) { if (listType !== 'ul') { closeList(); html += '<ul style="margin:.3rem 0 .3rem 1.15rem">'; listType = 'ul'; } html += `<li style="margin:.15rem 0">${ul[1]}</li>`; continue; }
    if (ol) { if (listType !== 'ol') { closeList(); html += '<ol style="margin:.3rem 0 .3rem 1.3rem">'; listType = 'ol'; } html += `<li style="margin:.15rem 0">${ol[1]}</li>`; continue; }
    closeList();
    if (line.trim() === '') continue;
    html += `<div style="margin:.15rem 0">${line}</div>`;
  }
  closeList();
  return html.replace(/@@AVA_BLOCK_(\d+)@@/g, (m, i) => blocks[+i] || '');
}

const MinimalAVA = () => {
  const [messages, setMessages] = useState([{
    id: 1,
    type: 'bot',
    text: "Hello! I'm AVA. This view now mirrors my voice conversation and shows the tasks I run live.",
    timestamp: Date.now()
  }]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [pendingMods, setPendingMods] = useState([]);   // self-modifications awaiting approval
  const [smBusy, setSmBusy] = useState('');             // id currently being approved/rejected
  const actedModsRef = useRef(new Set());               // ids the user approved/rejected — never re-show
  const [pendingVerifs, setPendingVerifs] = useState([]);   // Moltbook posts awaiting your verification answer
  const [verifAnswers, setVerifAnswers] = useState({});     // verification_code -> answer text
  const [verifBusy, setVerifBusy] = useState('');
  const [verifError, setVerifError] = useState('');
  const submittedVerifsRef = useRef(new Set());
  const sendInFlightRef = useRef(false);
  const [activity, setActivity] = useState([]);   // live "what AVA is doing right now" work-step feed
  const [working, setWorking] = useState(false);   // true while a workflow/tool run is in progress
  const workIdleRef = useRef(null);
  const [liveText, setLiveText] = useState('');    // assistant.delta stream — the reply typing in live

  // AVA's own aesthetic: load the theme SHE set via self_express and apply it (appearance only).
  // Tier 2 #15: no more 30s polling — one snapshot fetch, then she PUSHES self.theme when she
  // restyles herself; a socket (re)open refreshes the snapshot.
  useEffect(() => {
    let alive = true;
    const applyThemeObj = (t) => {
      if (!alive || !t) return;
      const root = document.documentElement;
      for (const [k, v] of Object.entries(t)) root.style.setProperty(`--ava-${k}`, v);
      if (t.bg) document.body.style.background = t.bg;
      if (t.text) document.body.style.color = t.text;
    };
    const fetchTheme = async () => {
      try { const r = await fetch(`${API_BASE}/self/theme`); const j = await r.json(); applyThemeObj(j && j.theme); }
      catch { /* keep defaults */ }
    };
    fetchTheme();
    const un = subscribe((ev) => {
      if (ev.type === 'self.theme') applyThemeObj(ev.data && ev.data.theme);
      else if (ev.type === 'ws.open') fetchTheme();
    });
    return () => { alive = false; un(); };
  }, []);

  // Dedupe: web-chat turns are shown locally; skip their WebSocket echoes by content.
  const recentKeysRef = useRef(new Map());
  const noteKey = useCallback((type, text) => {
    recentKeysRef.current.set(keyOf(type, text), Date.now());
  }, []);
  const isDup = useCallback((type, text) => {
    const t = recentKeysRef.current.get(keyOf(type, text));
    return t && (Date.now() - t) < 12000;
  }, []);

  const scrollRef = useRef(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, liveText]);

  // ---- Live event stream (voice turns + tool activity) ----
  useEffect(() => {
    let ws, retry, closed = false;

    const rid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const addConv = (type, text) => {
      if (!text || !String(text).trim()) return;
      if (isDup(type, text)) return;            // it's an echo of a web-chat turn
      noteKey(type, text);
      setMessages(prev => [...prev, { id: `v-${rid()}`, type, text: String(text), timestamp: Date.now(), via: 'voice' }]);
    };

    const addToolStart = (d) => {
      const tool = (d && d.tool) || 'tool';
      setMessages(prev => [...prev, { id: `t-${rid()}`, type: 'tool', tool, status: 'running', summary: '', timestamp: Date.now() }]);
    };

    const addToolResult = (d) => {
      const tool = (d && d.tool) || 'tool';
      const ok = !!(d && d.ok);
      const summary = (d && (d.summary || d.status)) || '';
      setMessages(prev => {
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].type === 'tool' && prev[i].tool === tool && prev[i].status === 'running') {
            const copy = prev.slice();
            copy[i] = { ...prev[i], status: ok ? 'ok' : 'error', summary };
            return copy;
          }
        }
        return [...prev, { id: `t-${rid()}`, type: 'tool', tool, status: ok ? 'ok' : 'error', summary, timestamp: Date.now() }];
      });
    };

    const argHint = (a) => {
      try {
        if (!a) return '';
        if (a.query) return a.query;
        if (a.url) return a.url;
        if (a.path || a.file) return a.path || a.file;
        const k = Object.keys(a)[0];
        return k ? String(a[k]).slice(0, 60) : '';
      } catch { return ''; }
    };
    const markWorking = () => {
      setWorking(true);
      clearTimeout(workIdleRef.current);
      // Tier 2 #15: agent.state working.end is the REAL end signal now — this long timer is
      // only a crash failsafe (each new event re-arms it), not the 15s guess it used to be.
      workIdleRef.current = setTimeout(() => setWorking(false), 120000);
    };
    const pushActivity = (label, detail, kind) => {
      if (!label) return;
      markWorking();
      setActivity(prev => [...prev.slice(-7), { id: `a-${rid()}`, label: String(label), detail: String(detail || '').slice(0, 160), kind: kind || 'step', at: Date.now() }]);
    };

    const handleEvent = (ev) => {
      if (!ev || !ev.type) return;
      const d = ev.data || {};
      switch (ev.type) {
        case 'transcript.final': addConv('user', d.text); break;
        case 'assistant.final': addConv('bot', d.text); setWorking(false); setLiveText(''); break;
        case 'assistant.delta': setLiveText(prev => prev + String(d.text || '')); break;
        case 'agent.state':   // Tier 2 #15: explicit working signal from the agent loop
          if (d.state === 'working.start') markWorking();
          else if (d.state === 'working.end') { clearTimeout(workIdleRef.current); workIdleRef.current = setTimeout(() => setWorking(false), 1200); }
          break;
        case 'tool.start':
          if (ev.source === 'voice') addToolStart(d);              // chat-inline card (voice only, unchanged)
          pushActivity(`Using ${d.tool || 'a tool'}`, argHint(d.args), 'tool');  // live work popup (all sources)
          break;
        case 'tool.result':
          if (ev.source === 'voice') addToolResult(d);
          pushActivity(`${d.tool || 'tool'} ${d.ok ? '✓' : '✕'}`, d.summary || d.status, d.ok ? 'tool-ok' : 'tool-err');
          break;
        case 'agent.activity':   // lead/subagent workflow steps: delegate, subagent_start/done, synthesize, done
          pushActivity(d.label, d.detail, d.phase);
          if (d.phase === 'done') { clearTimeout(workIdleRef.current); workIdleRef.current = setTimeout(() => setWorking(false), 4000); }
          break;
        default: break;
      }
    };

    const connect = () => {
      try { ws = new WebSocket(WS_URL); } catch { retry = setTimeout(connect, 3000); return; }
      // Tier 2 #15: this is THE one socket — every event fans out through liveBus so the
      // theme/self-mod/verification/panel subscribers stay in sync with zero polling.
      ws.onopen = () => { setConnected(true); publish({ type: 'ws.open' }); };
      ws.onclose = () => { setConnected(false); if (!closed) retry = setTimeout(connect, 3000); };
      ws.onerror = () => { try { ws.close(); } catch { /* */ } };
      ws.onmessage = (e) => {
        let ev = null;
        try { ev = JSON.parse(e.data); } catch { /* */ }
        if (!ev) return;
        try { handleEvent(ev); } catch { /* */ }
        publish(ev);
      };
    };
    connect();
    return () => { closed = true; clearTimeout(retry); try { ws && ws.close(); } catch { /* */ } };
  }, [isDup, noteKey]);

  // ---- Proposed self-modifications awaiting the user's approval ----
  // Tier 2 #15: event-driven (selfmod.pending is pushed at every queue change) — one
  // snapshot fetch on load and on socket (re)open replaces the old 6s poll.
  useEffect(() => {
    let stop = false;
    const applyList = (list) => {
      if (stop) return;
      setPendingMods(Array.isArray(list) ? list.filter(m => (m.status || 'pending') === 'pending' && !actedModsRef.current.has(m.id)) : []);
    };
    const fetchPending = async () => {
      try {
        const r = await fetch(`${API_BASE}/self_mod`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'list_pending' })
        });
        const j = await r.json().catch(() => ({}));
        applyList((j && (j.pending || j.modifications)) || []);
      } catch { /* server may be restarting */ }
    };
    fetchPending();
    const un = subscribe((ev) => {
      if (ev.type === 'selfmod.pending') applyList((ev.data && ev.data.pending) || []);
      else if (ev.type === 'ws.open') fetchPending();
    });
    return () => { stop = true; un(); };
  }, []);

  const actOnMod = async (id, action) => {
    setSmBusy(id);
    actedModsRef.current.add(id);                          // remember — polling must not re-add it
    setPendingMods(prev => prev.filter(m => m.id !== id)); // close the card immediately
    try {
      await fetch(`${API_BASE}/self_mod`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, modification_id: id })
      });
    } catch { /* card stays closed; server state reconciles */ } finally { setSmBusy(''); }
  };

  // ---- Moltbook posts awaiting the user's verification answer ----
  // Tier 2 #15: event-driven (moltbook.verifications is pushed at every queue change) —
  // one snapshot fetch on load and on socket (re)open replaces the old 10s poll.
  useEffect(() => {
    let stop = false;
    const applyPending = (pending) => {
      if (stop) return;
      const list = Array.isArray(pending) ? pending : [];
      setPendingVerifs(list.filter(v => !submittedVerifsRef.current.has(v.verification_code)));
    };
    const fetchVerifs = async () => {
      try {
        const r = await fetch(`${API_BASE}/moltbook/verifications`).then(x => x.json());
        applyPending(r && r.pending);
      } catch { /* server may be restarting */ }
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
    setVerifBusy(code);
    setVerifError('');
    submittedVerifsRef.current.add(code);
    setPendingVerifs(prev => prev.filter(v => v.verification_code !== code));
    try {
      const r = await fetch(`${API_BASE}/moltbook/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, answer })
      }).then(x => x.json()).catch(() => ({}));
      if (r && (r.ok || r.cleared)) {
        setVerifAnswers(a => {
          const next = { ...a };
          delete next[code];
          return next;
        });
      } else {
        submittedVerifsRef.current.delete(code);
        if (current) setPendingVerifs(prev => prev.some(v => v.verification_code === code) ? prev : [current, ...prev]);
        setVerifError(r?.error || r?.result?.error || r?.result?.message || 'Moltbook did not accept that answer. Please check it and try again.');
      }
    } catch {
      submittedVerifsRef.current.delete(code);
      if (current) setPendingVerifs(prev => prev.some(v => v.verification_code === code) ? prev : [current, ...prev]);
      setVerifError('Could not reach AVA server. Please try again.');
    } finally { setVerifBusy(''); }
  };

  const sendMessage = async () => {
    if (!inputText.trim() || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    const text = inputText;
    const userMessage = { id: Date.now(), type: 'user', text, timestamp: Date.now() };
    setMessages(prev => [...prev, userMessage]);
    noteKey('user', text);              // so the WS echo of this turn is skipped
    setInputText('');
    setIsLoading(true);

    try {
      const API_BASE = (import.meta?.env?.VITE_AVA_SERVER_URL || '/api').replace(/\/$/, '');
      const lower = text.toLowerCase();
      const fmtMatch = lower.match(/\b(pdf|docx|xlsx|pptx|rtf|txt|md|csv|json|html)\b/);
      if (/(create|generate|make|write).*\b(pdf|docx|xlsx|pptx|rtf|txt|md|csv|json|html)\b/.test(lower)) {
        const fmt = (fmtMatch ? fmtMatch[1] : 'txt').toLowerCase();
        const dir = /documents?/.test(lower) ? 'documents' : 'downloads';
        const content = /random/.test(lower)
          ? `Random message ${Math.random().toString(36).slice(2, 8)} from AVA.`
          : text;
        const respDoc = await fetch(`${API_BASE}/tools/file_gen`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ format: fmt, content, dir })
        });
        const docData = await respDoc.json().catch(() => ({}));
        const botText = docData?.ok
          ? `Created ${fmt.toUpperCase()}: ${docData.path || 'file created'}`
          : (docData?.text || docData?.error || 'Could not create the document.');
        setMessages(prev => [...prev, { id: Date.now() + 1, type: 'bot', text: botText, timestamp: Date.now() }]);
        noteKey('bot', botText);
        return;
      }

      const response = await fetch(`${API_BASE}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, session_id: 'enhanced-client' })
      });
      const data = await response.json();
      if (data?.duplicate_suppressed) return;
      const botText = data.message || data.text || "Sorry, I couldn't process that.";
      if (isDup('bot', botText)) return;
      setMessages(prev => [...prev, { id: Date.now() + 1, type: 'bot', text: botText, timestamp: Date.now() }]);
      noteKey('bot', botText);
    } catch (error) {
      setMessages(prev => [...prev, { id: Date.now() + 1, type: 'bot', text: `Error: ${error.message}`, timestamp: Date.now() }]);
    } finally {
      sendInFlightRef.current = false;
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const toolIcon = (s) => (s === 'running' ? '⏳' : s === 'ok' ? '✅' : '⚠️');

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', fontFamily: 'Inter, system-ui, sans-serif', backgroundColor: '#f8fafc' }}>
      <style>{`@keyframes avapulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.5);opacity:.6}}`}</style>
      {activity.length > 0 && (
        <div style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 9999, width: 340, maxWidth: '90vw',
          background: '#0b1021', color: '#e5e7eb', borderRadius: '0.9rem', boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
          border: '1px solid #1f2a44', overflow: 'hidden', fontSize: '0.8rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.55rem 0.85rem', background: 'linear-gradient(135deg,#4338ca,#7c3aed)', fontWeight: 600 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: working ? '#34d399' : '#9ca3af', boxShadow: working ? '0 0 8px #34d399' : 'none', animation: working ? 'avapulse 1.2s ease-in-out infinite' : 'none' }} />
            {working ? 'AVA is working…' : 'AVA — last activity'}
            <span style={{ marginLeft: 'auto', cursor: 'pointer', opacity: 0.8 }} onClick={() => setActivity([])} title="dismiss">✕</span>
          </div>
          <div style={{ maxHeight: 240, overflowY: 'auto', padding: '0.3rem 0.45rem' }}>
            {activity.slice().reverse().map((a) => (
              <div key={a.id} style={{ display: 'flex', gap: 8, padding: '0.35rem 0.4rem', borderBottom: '1px solid #131a2e' }}>
                <span style={{ fontSize: '0.95rem', lineHeight: '1.1rem' }}>{a.kind === 'tool-ok' ? '✅' : a.kind === 'tool-err' ? '⚠️' : a.kind === 'subagent_start' ? '🤖' : a.kind === 'subagent_done' ? '✔️' : a.kind === 'delegate' ? '🧩' : a.kind === 'synthesize' ? '🧠' : a.kind === 'done' ? '🏁' : '⏳'}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.label}</div>
                  {a.detail ? <div style={{ opacity: 0.65, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.detail}</div> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div style={{ padding: '1rem 2rem', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: 'white', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
        <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 600 }}>AVA — Live</h1>
        <p style={{ margin: '0.5rem 0 0 0', opacity: 0.9, fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: connected ? '#34d399' : '#9ca3af', display: 'inline-block', boxShadow: connected ? '0 0 6px #34d399' : 'none' }} />
          {connected ? 'Live — mirroring voice + tasks' : 'Connecting to AVA…'}
        </p>
      </div>

      <div ref={scrollRef} style={{ flex: 1, padding: '1.5rem', overflowY: 'auto' }}>
        {messages.map((message) => {
          if (message.type === 'tool') {
            return (
              <div key={message.id} style={{ display: 'flex', justifyContent: 'center', marginBottom: '0.9rem' }}>
                <div style={{
                  maxWidth: '85%', width: 'fit-content', padding: '0.6rem 0.9rem', borderRadius: '0.75rem',
                  background: message.status === 'error' ? '#fef2f2' : '#eef2ff',
                  border: `1px solid ${message.status === 'error' ? '#fecaca' : '#c7d2fe'}`,
                  color: '#374151', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '0.5rem'
                }}>
                  <span>{toolIcon(message.status)}</span>
                  <span style={{ fontWeight: 600, fontFamily: 'ui-monospace, monospace' }}>{message.tool}</span>
                  <span style={{ opacity: 0.85 }}>
                    {message.status === 'running' ? 'running…' : (message.summary || (message.status === 'ok' ? 'done' : 'failed'))}
                  </span>
                </div>
              </div>
            );
          }
          return (
            <div key={message.id} style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: message.type === 'user' ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: '70%', padding: '1rem 1.25rem',
                borderRadius: message.type === 'user' ? '1.5rem 1.5rem 0.25rem 1.5rem' : '1.5rem 1.5rem 1.5rem 0.25rem',
                background: message.type === 'user' ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' : 'white',
                color: message.type === 'user' ? 'white' : '#1f2937',
                boxShadow: '0 2px 8px rgba(0,0,0,0.1)', fontSize: '0.925rem', lineHeight: 1.6
              }}>
                {(() => {
                  if (message.type === 'bot') {
                    const m = String(message.text || '');
                    const match = m.match(/Created\s+([A-Z]+):\s+(.+)$/);
                    if (match) {
                      const API_BASE = (import.meta?.env?.VITE_AVA_SERVER_URL || '/api').replace(/\/$/, '');
                      const href = `${API_BASE}/files/download?p=${encodeURIComponent(match[2])}`;
                      return (<span>{`Created ${match[1]}: `}<a href={href} target="_blank" rel="noopener noreferrer">{match[2]}</a></span>);
                    }
                    return <div className="ava-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m) }} />;
                  }
                  return <span style={{ whiteSpace: 'pre-wrap' }}>{message.text}</span>;
                })()}
                <div style={{ fontSize: '0.7rem', opacity: 0.6, marginTop: '0.5rem', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                  {new Date(message.timestamp).toLocaleTimeString()}
                  {message.via === 'voice' && <span style={{ background: 'rgba(102,126,234,0.15)', color: '#4f46e5', padding: '0 0.35rem', borderRadius: '0.4rem' }}>voice</span>}
                </div>
              </div>
            </div>
          );
        })}
        {liveText && (
          <div style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{ maxWidth: '70%', padding: '1rem 1.25rem', borderRadius: '1.5rem 1.5rem 1.5rem 0.25rem', background: 'white', color: '#1f2937', boxShadow: '0 2px 8px rgba(0,0,0,0.1)', fontSize: '0.925rem', lineHeight: 1.6 }}>
              <div className="ava-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(liveText) }} />
              <div style={{ fontSize: '0.7rem', opacity: 0.6, marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#667eea', animation: 'pulse 1.2s ease-in-out infinite' }} />
                speaking…
              </div>
            </div>
          </div>
        )}
        {isLoading && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '1rem' }}>
            <div style={{ padding: '1rem 1.25rem', borderRadius: '1.5rem 1.5rem 1.5rem 0.25rem', backgroundColor: 'white', boxShadow: '0 2px 8px rgba(0,0,0,0.1)', fontSize: '0.925rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#667eea', animation: 'pulse 1.5s ease-in-out infinite' }} />
              AVA is thinking...
            </div>
          </div>
        )}
      </div>

      {pendingVerifs.length > 0 && (
        <div style={{ borderTop: '1px solid #bfdbfe', background: '#eff6ff', maxHeight: '38vh', overflowY: 'auto', padding: '1rem 1.5rem' }}>
          <div style={{ fontWeight: 700, color: '#1e40af', fontSize: '0.9rem', marginBottom: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span>🔐 Moltbook post needs your verification</span>
            <span style={{ background: '#2563eb', color: 'white', borderRadius: '0.6rem', padding: '0 0.5rem', fontSize: '0.75rem' }}>{pendingVerifs.length}</span>
          </div>
          {verifError && <div style={{ color: '#b91c1c', fontSize: '0.8rem', marginBottom: '0.6rem' }}>{verifError}</div>}
          {pendingVerifs.map((v) => (
            <div key={v.verification_code} style={{ background: 'white', border: '1px solid #bfdbfe', borderRadius: '0.6rem', padding: '0.75rem 0.9rem', marginBottom: '0.7rem' }}>
              <div style={{ fontWeight: 600, color: '#1f2937', fontSize: '0.85rem' }}>{v.title || 'Untitled post'}</div>
              <div style={{ color: '#374151', fontSize: '0.85rem', margin: '0.4rem 0', fontStyle: 'italic' }}>{v.challenge_text}</div>
              {v.instructions && <div style={{ color: '#6b7280', fontSize: '0.72rem', marginBottom: '0.5rem' }}>{v.instructions}</div>}
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  value={verifAnswers[v.verification_code] || ''}
                  onChange={(e) => setVerifAnswers(a => ({ ...a, [v.verification_code]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitVerif(v.verification_code); }}
                  placeholder="Your answer"
                  style={{ flex: 1, padding: '0.45rem 0.7rem', border: '1px solid #93c5fd', borderRadius: '0.45rem', fontSize: '0.85rem', outline: 'none' }}
                />
                <button onClick={() => submitVerif(v.verification_code)} disabled={verifBusy === v.verification_code || !(verifAnswers[v.verification_code] || '').trim()}
                  style={{ padding: '0.45rem 1rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: '0.5rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', opacity: verifBusy === v.verification_code ? 0.6 : 1 }}>
                  {verifBusy === v.verification_code ? '…' : 'Verify & publish'}
                </button>
              </div>
            </div>
          ))}
          <div style={{ fontSize: '0.72rem', color: '#1e40af', opacity: 0.8 }}>She drafts the post; you solve the platform's challenge to publish it (challenges expire ~10 min).</div>
        </div>
      )}

      {pendingMods.length > 0 && (
        <div style={{ borderTop: '1px solid #fde68a', background: '#fffbeb', maxHeight: '42vh', overflowY: 'auto', padding: '1rem 1.5rem' }}>
          <div style={{ fontWeight: 700, color: '#92400e', fontSize: '0.9rem', marginBottom: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span>🛠️ Proposed changes — your approval needed</span>
            <span style={{ background: '#f59e0b', color: 'white', borderRadius: '0.6rem', padding: '0 0.5rem', fontSize: '0.75rem' }}>{pendingMods.length}</span>
          </div>
          {pendingMods.map((m) => {
            const fname = String(m.file || '').split(/[\\/]/).pop();
            const reviewRecommendation = m.review_recommendation || m.reviewRecommendation || m.metadata?.reviewRecommendation;
            const reviewReason = m.review_reason || m.reviewReason || m.metadata?.reviewReason;
            const proposalModel = m.decision_model || m.decisionModel || m.metadata?.decisionModel;
            const planModel = m.plan_model || m.planModel || m.metadata?.planModel;
            const editModel = m.edit_model || m.editModel || m.metadata?.editModel;
            return (
              <div key={m.id} style={{ background: 'white', border: '1px solid #fcd34d', borderRadius: '0.6rem', padding: '0.75rem 0.9rem', marginBottom: '0.7rem' }}>
                <div style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 700, color: '#1f2937', fontSize: '0.85rem' }}>
                  {fname} <span style={{ fontWeight: 400, color: '#9ca3af', fontSize: '0.72rem' }}>#{m.id}</span>
                </div>
                {m.reason && <div style={{ color: '#4b5563', fontSize: '0.82rem', margin: '0.3rem 0 0.5rem' }}>{m.reason}</div>}
                {proposalModel && (
                  <div style={{ color: '#6b7280', fontSize: '0.74rem', margin: '0 0 0.45rem', fontFamily: 'ui-monospace, monospace' }}>
                    Proposal model: {proposalModel}{planModel || editModel ? ` (plan: ${planModel || 'unknown'}, edit: ${editModel || 'unknown'})` : ''}
                  </div>
                )}
                {reviewRecommendation && (
                  <div style={{ background: reviewRecommendation === 'deny' ? '#fef2f2' : reviewRecommendation === 'approve' ? '#f0fdf4' : '#f8fafc', border: `1px solid ${reviewRecommendation === 'deny' ? '#fecaca' : reviewRecommendation === 'approve' ? '#bbf7d0' : '#cbd5e1'}`, color: reviewRecommendation === 'deny' ? '#991b1b' : reviewRecommendation === 'approve' ? '#166534' : '#334155', borderRadius: '0.45rem', padding: '0.45rem 0.55rem', fontSize: '0.76rem', lineHeight: 1.35, margin: '0 0 0.55rem' }}>
                    <strong>Reviewer recommendation: {String(reviewRecommendation).toUpperCase()}</strong>{reviewReason ? ` - ${reviewReason}` : ''}
                  </div>
                )}
                {m.diff && (
                  <pre style={{ margin: 0, maxHeight: '200px', overflow: 'auto', background: '#0b1021', borderRadius: '0.4rem', padding: '0.6rem 0.75rem', fontSize: '0.72rem', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
                    {String(m.diff).split('\n').map((ln, i) => (
                      <div key={i} style={{ color: ln.startsWith('+') && !ln.startsWith('+++') ? '#86efac' : ln.startsWith('-') && !ln.startsWith('---') ? '#fca5a5' : ln.startsWith('@@') ? '#93c5fd' : '#cbd5e1' }}>{ln || ' '}</div>
                    ))}
                  </pre>
                )}
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
                  <button onClick={() => actOnMod(m.id, 'approve')} disabled={smBusy === m.id}
                    style={{ padding: '0.4rem 1rem', background: '#16a34a', color: 'white', border: 'none', borderRadius: '0.5rem', fontSize: '0.8rem', fontWeight: 600, cursor: smBusy === m.id ? 'not-allowed' : 'pointer', opacity: smBusy === m.id ? 0.6 : 1 }}>
                    {smBusy === m.id ? '…' : 'Approve & apply'}
                  </button>
                  <button onClick={() => actOnMod(m.id, 'reject')} disabled={smBusy === m.id}
                    style={{ padding: '0.4rem 1rem', background: 'white', color: '#b91c1c', border: '1px solid #fca5a5', borderRadius: '0.5rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}>
                    Reject
                  </button>
                </div>
              </div>
            );
          })}
          <div style={{ fontSize: '0.72rem', color: '#92400e', opacity: 0.8 }}>Approve or reject right here with the buttons — it's applied immediately. Or, by voice, say "approve change {pendingMods[0] ? pendingMods[0].id : ''}" or "reject it".</div>
        </div>
      )}

      <div style={{ padding: '1.5rem', backgroundColor: 'white', borderTop: '1px solid #e5e7eb', boxShadow: '0 -4px 6px rgba(0,0,0,0.05)' }}>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <input
            type="text" value={inputText}
            onChange={(e) => setInputText(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Type here, or just talk to her — voice shows up live above…"
            disabled={isLoading}
            style={{ flex: 1, padding: '0.875rem 1.25rem', border: '2px solid #e5e7eb', borderRadius: '1rem', fontSize: '0.925rem', outline: 'none', backgroundColor: isLoading ? '#f3f4f6' : 'white', fontFamily: 'inherit' }}
            onFocus={(e) => e.target.style.borderColor = '#667eea'}
            onBlur={(e) => e.target.style.borderColor = '#e5e7eb'}
          />
          <button onClick={sendMessage} disabled={isLoading || !inputText.trim()}
            style={{ padding: '0.875rem 1.5rem', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: 'white', border: 'none', borderRadius: '1rem', fontSize: '0.925rem', cursor: isLoading ? 'not-allowed' : 'pointer', opacity: isLoading ? 0.6 : 1, fontWeight: 500 }}>
            {isLoading ? 'Sending...' : 'Send'}
          </button>
        </div>
        <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: '#6b7280', textAlign: 'center' }}>
          Speak to AVA and watch her replies + the tools she runs appear here in real time.
        </div>
      </div>

      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
    </div>
  );
};

export default MinimalAVA;
