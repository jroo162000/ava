import React, { useEffect, useRef, useState } from 'react'
import { subscribe } from '../liveBus.js'

// ArtifactPanel — AVA's visual PRESENTER. Mirrors backend panel state (/panel/state): however many
// cards she opened, in the layout SHE chose (spread = all visible; stack = fanned), placed where she
// put them, with the referenced one highlighted. Renders news/article cards, photos, autoplay-muted
// video, web pages, mermaid, markdown, tables. She drives it (open/focus/layout/move/close) via the
// panel tool; the user can also click to highlight, drag a card, or cycle/close.

// Default to the same-origin /api proxy (Tier 0 security: the Vite proxy injects the
// API token server-side). VITE_AVA_SERVER_URL still overrides for direct connections.
const SERVER = (import.meta.env.VITE_AVA_SERVER_URL || '/api')
const api = (p, body) => fetch(`${SERVER}${p}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
function inline(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
}
function md2html(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n'); const out = []; let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const head = cells(line); let j = i + 2; const rows = []
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) { rows.push(cells(lines[j])); j++ }
      out.push('<table><thead><tr>' + head.map((h) => '<th>' + inline(h) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>'); i = j; continue
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) { out.push('<h' + (h[1].length + 3) + '>' + inline(h[2]) + '</h' + (h[1].length + 3) + '>'); i++; continue }
    if (/^\s*[-*]\s+/.test(line)) { const items = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push('<li>' + inline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>'); i++ } out.push('<ul>' + items.join('') + '</ul>'); continue }
    if (line.trim() === '') { i++; continue }
    out.push('<p>' + inline(line) + '</p>'); i++
  }
  return out.join('')
}
let _mermaidLoading = null
function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid)
  if (_mermaidLoading) return _mermaidLoading
  _mermaidLoading = new Promise((resolve) => {
    const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js'
    s.onload = () => { try { window.mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' }) } catch {} resolve(window.mermaid) }
    s.onerror = () => resolve(null); document.head.appendChild(s)
  })
  return _mermaidLoading
}
function MermaidBlock({ code, id }) {
  const ref = useRef(null)
  useEffect(() => {
    let dead = false
    loadMermaid().then((m) => { if (dead || !ref.current) return; if (!m) { ref.current.innerHTML = '<pre>' + esc(code) + '</pre>'; return } m.render('mm_' + id, code).then(({ svg }) => { if (!dead && ref.current) ref.current.innerHTML = svg }).catch(() => { if (ref.current) ref.current.innerHTML = '<pre>' + esc(code) + '</pre>' }) })
    return () => { dead = true }
  }, [code, id])
  return <div ref={ref} style={{ overflowX: 'auto' }} />
}
function ytId(u) { const m = String(u || '').match(/(?:youtu\.be\/|[?&]v=|embed\/|shorts\/)([A-Za-z0-9_-]{6,})/); if (m) return m[1]; return /^[A-Za-z0-9_-]{6,}$/.test(String(u || '').trim()) ? u.trim() : null }

function CardBody({ c }) {
  const t = c.type
  if (t === 'image' || t === 'photo') return <img src={c.content} alt={c.title || ''} style={{ maxWidth: '100%', borderRadius: 8, display: 'block' }} />
  if (t === 'video') { const id = ytId(c.content); if (id) return <div style={{ position: 'relative', paddingTop: '56%' }}><iframe title={c.title} src={`https://www.youtube.com/embed/${id}?autoplay=1&mute=1&rel=0`} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, borderRadius: 8 }} /></div>; return <video src={c.content} autoPlay muted controls style={{ width: '100%', borderRadius: 8 }} /> }
  if (t === 'web') return <div><iframe title={c.title} src={c.content} sandbox="allow-scripts allow-same-origin allow-popups" allow="xr-spatial-tracking; fullscreen; accelerometer; gyroscope" style={{ width: '100%', height: 300, border: 0, borderRadius: 8, background: '#fff' }} /><div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>If blank, the site blocks embedding — <a href={c.content} target="_blank" rel="noreferrer" style={{ color: '#a78bfa' }}>open it</a>.</div></div>
  if (t === 'news') {
    let items = []; try { items = Array.isArray(c.content) ? c.content : JSON.parse(c.content) } catch { items = [] }
    if (!items.length) return <div dangerouslySetInnerHTML={{ __html: md2html(String(c.content)) }} />
    return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{items.slice(0, 6).map((a, i) => (
      <a key={i} href={a.url} target="_blank" rel="noreferrer" style={{ display: 'flex', gap: 8, textDecoration: 'none', color: 'inherit', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: 7 }}>
        {a.image ? <img src={a.image} alt="" style={{ width: 72, height: 54, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} /> : null}
        <span><span style={{ fontWeight: 600, fontSize: 12.5, color: '#e2e8f0', display: 'block' }}>{a.title}</span><span style={{ fontSize: 11, color: '#94a3b8' }}>{a.source || ''}</span>{a.snippet ? <span style={{ fontSize: 11.5, color: '#cbd5e1', display: 'block', marginTop: 2 }}>{String(a.snippet).slice(0, 120)}</span> : null}</span>
      </a>))}</div>
  }
  if (t === 'mermaid') return <MermaidBlock code={c.content} id={c.id} />
  return <div dangerouslySetInnerHTML={{ __html: md2html(c.content) }} />
}

const btn = { background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', color: '#94a3b8', borderRadius: 8, padding: '2px 8px', cursor: 'pointer', fontSize: 12 }

export default function ArtifactPanel() {
  const [cards, setCards] = useState([])
  const [focusedId, setFocusedId] = useState(null)
  const [layout, setLayout] = useState('spread')
  const [hidden, setHidden] = useState(false)
  const [drag, setDrag] = useState(null) // {id, x, y} live override during a drag
  const stageRef = useRef(null)

  // Tier 2 #15: artifactBus already emits a `panel` event on every change — subscribe to the
  // shared /voice/ws fan-out (liveBus) instead of hammering /panel/state every second. One
  // snapshot fetch on mount and on socket (re)open keeps reconnects honest.
  useEffect(() => {
    let stop = false
    const applyState = (j) => { if (stop || !j) return; setCards(j.cards || []); setFocusedId(j.focusedId || null); if (j.layout) setLayout(j.layout) }
    const fetchState = async () => {
      try { const r = await api('/panel/state'); const j = await r.json(); if (j && j.ok) applyState(j) } catch {}
    }
    fetchState()
    const un = subscribe((ev) => {
      if (ev.type === 'panel') applyState(ev.data || {})
      else if (ev.type === 'ws.open') fetchState()
    })
    return () => { stop = true; un() }
  }, [])

  const focus = (id) => { setFocusedId(id); api('/panel/focus', { id }).catch(() => {}) }
  const close = (id) => { setCards((cs) => cs.filter((c) => c.id !== id)); api('/panel/close', { id }).catch(() => {}) }
  const clearAll = () => { setCards([]); api('/panel/clear', {}).catch(() => {}) }
  const toggleLayout = () => { const m = layout === 'spread' ? 'stack' : 'spread'; setLayout(m); api('/panel/layout', { mode: m }).catch(() => {}) }
  const cycle = (dir) => { if (!cards.length) return; const i = Math.max(0, cards.findIndex((c) => c.id === focusedId)); focus(cards[(i + dir + cards.length) % cards.length].id) }

  // drag (spread mode): move a card and persist normalized position on drop
  const onDragStart = (e, id) => {
    if (layout !== 'spread') return
    e.preventDefault(); focus(id)
    const move = (ev) => {
      const s = stageRef.current; if (!s) return; const r = s.getBoundingClientRect()
      const x = Math.max(0, Math.min(1, (ev.clientX - r.left - 130) / Math.max(1, r.width - 260)))
      const y = Math.max(0, Math.min(1, (ev.clientY - r.top - 20) / Math.max(1, r.height - 120)))
      setDrag({ id, x, y })
    }
    const up = (ev) => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
      const s = stageRef.current; if (s) { const r = s.getBoundingClientRect(); const x = Math.max(0, Math.min(1, (ev.clientX - r.left - 130) / Math.max(1, r.width - 260))); const y = Math.max(0, Math.min(1, (ev.clientY - r.top - 20) / Math.max(1, r.height - 120))); api('/panel/move', { id, x, y }).catch(() => {}) }
      setDrag(null)
    }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }

  if (!cards.length) return null
  if (hidden) return <button onClick={() => setHidden(false)} style={{ position: 'fixed', right: 0, top: '40%', zIndex: 99999, background: '#8b5cf6', color: '#fff', border: 0, borderRadius: '10px 0 0 10px', padding: '10px 8px', writingMode: 'vertical-rl', cursor: 'pointer', fontWeight: 700, fontSize: 12 }}>Visuals ({cards.length})</button>

  const fIdx = Math.max(0, cards.findIndex((c) => c.id === focusedId))
  const spread = layout === 'spread'
  const wide = spread ? 'min(64vw, 780px)' : 'min(46vw, 560px)'
  return (
    <div style={{ position: 'fixed', right: 14, top: 14, bottom: 14, width: wide, zIndex: 99999, display: 'flex', flexDirection: 'column', pointerEvents: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'rgba(15,17,26,0.92)', border: '1px solid rgba(139,92,246,0.35)', borderRadius: 12, marginBottom: 8, color: '#e2e8f0', pointerEvents: 'auto', backdropFilter: 'blur(8px)' }}>
        <span style={{ width: 8, height: 8, borderRadius: 8, background: '#8b5cf6' }} />
        <span style={{ fontWeight: 700, fontSize: 13 }}>AVA · Presenting</span>
        <span style={{ fontSize: 11, color: '#64748b' }}>{cards.length}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={toggleLayout} title="Toggle layout" style={btn}>{spread ? 'Stack' : 'Spread'}</button>
          <button onClick={() => cycle(-1)} title="Previous" style={btn}>‹</button>
          <button onClick={() => cycle(1)} title="Next" style={btn}>›</button>
          <button onClick={clearAll} title="Clear all" style={btn}>Clear</button>
          <button onClick={() => setHidden(true)} title="Hide" style={btn}>Hide</button>
        </span>
      </div>
      <div ref={stageRef} style={{ position: 'relative', flex: 1 }}>
        {cards.map((c, idx) => {
          const isFront = c.id === focusedId
          const dpos = drag && drag.id === c.id ? drag : null
          const pos = dpos || (c.meta && c.meta.pos) || null
          let style
          if (spread) {
            const auto = !pos
            const col = idx % 2, row = Math.floor(idx / 2)
            const left = pos ? `calc(${pos.x} * (100% - 260px))` : `calc(${col} * (100% - 260px))`
            const top = pos ? `calc(${pos.y} * (100% - 120px))` : `${row * 200}px`
            style = { position: 'absolute', left, top, width: 260, maxHeight: '62%', overflowY: 'auto', pointerEvents: 'auto', background: 'rgba(17,19,29,0.97)', border: `1px solid ${isFront ? 'rgba(139,92,246,0.85)' : 'rgba(255,255,255,0.08)'}`, borderRadius: 14, boxShadow: isFront ? '0 0 0 2px rgba(139,92,246,0.5), 0 14px 40px rgba(0,0,0,0.55)' : '0 6px 18px rgba(0,0,0,0.4)', transform: isFront ? 'scale(1.02)' : 'none', opacity: isFront ? 1 : 0.82, zIndex: isFront ? 100 : 40 + idx, transition: dpos ? 'none' : 'all 0.16s ease' }
            void auto
          } else {
            const depth = idx <= fIdx ? fIdx - idx : idx - fIdx
            style = { position: 'absolute', top: 0, right: 0, width: '100%', maxHeight: '100%', overflowY: 'auto', pointerEvents: 'auto', background: 'rgba(17,19,29,0.96)', border: `1px solid ${isFront ? 'rgba(139,92,246,0.6)' : 'rgba(255,255,255,0.08)'}`, borderRadius: 14, boxShadow: isFront ? '0 14px 44px rgba(0,0,0,0.55)' : '0 6px 20px rgba(0,0,0,0.4)', transform: isFront ? 'none' : `translate(${Math.min(depth, 5) * -16}px, ${Math.min(depth, 5) * 14 + 6}px) scale(0.955)`, opacity: isFront ? 1 : 0.5, zIndex: isFront ? 100 : 40 - depth, transition: 'all 0.18s ease', cursor: isFront ? 'default' : 'pointer' }
          }
          return (
            <div key={c.id} style={style} onClick={!isFront && !spread ? () => focus(c.id) : undefined}>
              <div onMouseDown={(e) => onDragStart(e, c.id)} onClick={spread && !isFront ? () => focus(c.id) : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: '1px solid rgba(255,255,255,0.07)', position: 'sticky', top: 0, background: 'rgba(17,19,29,0.98)', borderRadius: '14px 14px 0 0', cursor: spread ? 'move' : 'default' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#8b5cf6' }}>#{idx + 1}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title || c.type}</span>
                <span style={{ fontSize: 10, color: '#64748b' }}>{c.type}</span>
                <button onClick={(e) => { e.stopPropagation(); close(c.id) }} title="Close" style={{ ...btn, marginLeft: 'auto', padding: '1px 7px' }}>✕</button>
              </div>
              <div style={{ padding: 11, fontSize: 13, color: '#e2e8f0', lineHeight: 1.5 }}><CardBody c={c} /></div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
