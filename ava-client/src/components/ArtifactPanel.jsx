import React, { useEffect, useRef, useState } from 'react'

// ArtifactPanel — AVA's visual reference popup. Self-contained: it polls the backend artifact feed
// (/artifacts/recent), and slides in a collapsible panel that renders whatever she wants to SHOW —
// Mermaid diagrams, markdown, tables, web-result summaries, images, notes, the menu. It pops open on
// its own when she surfaces a visual while explaining something, and can be collapsed to a small tab.

const SERVER = (import.meta.env.VITE_AVA_SERVER_URL || 'http://127.0.0.1:5051')

// ---- tiny, dependency-free markdown (headers, bold/italic/code, lists, GFM tables) ----
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
}
function md2html(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // table: header row + separator row of ---
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const head = cells(line)
      let j = i + 2
      const rows = []
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) { rows.push(cells(lines[j])); j++ }
      out.push('<table><thead><tr>' + head.map((h) => '<th>' + inline(h) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>')
      i = j; continue
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) { out.push('<h' + (h[1].length + 2) + '>' + inline(h[2]) + '</h' + (h[1].length + 2) + '>'); i++; continue }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push('<li>' + inline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>'); i++ }
      out.push('<ul>' + items.join('') + '</ul>'); continue
    }
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
    const s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js'
    s.onload = () => { try { window.mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' }) } catch {} resolve(window.mermaid) }
    s.onerror = () => resolve(null)
    document.head.appendChild(s)
  })
  return _mermaidLoading
}

function MermaidBlock({ code, id }) {
  const ref = useRef(null)
  useEffect(() => {
    let dead = false
    loadMermaid().then((m) => {
      if (dead || !ref.current) return
      if (!m) { ref.current.innerHTML = '<pre>' + esc(code) + '</pre>'; return }
      m.render('m_' + id, code).then(({ svg }) => { if (!dead && ref.current) ref.current.innerHTML = svg })
        .catch(() => { if (ref.current) ref.current.innerHTML = '<pre>' + esc(code) + '</pre>' })
    })
    return () => { dead = true }
  }, [code, id])
  return <div ref={ref} style={{ overflowX: 'auto' }} />
}

function Artifact({ a, n }) {
  let body
  if (a.type === 'mermaid') body = <MermaidBlock code={a.content} id={a.id} />
  else if (a.type === 'image') {
    const src = /^(https?:|data:)/.test(a.content) ? a.content : `${SERVER}/file?path=${encodeURIComponent(a.content)}`
    body = <img src={src} alt={a.title || 'image'} style={{ maxWidth: '100%', borderRadius: 8 }} />
  } else body = <div dangerouslySetInnerHTML={{ __html: md2html(a.content) }} />
  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 12, marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#8b5cf6', minWidth: 20 }}>#{n}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#cbd5e1', textTransform: 'capitalize' }}>{a.title || a.type}</span>
        <span style={{ fontSize: 10, color: '#64748b', marginLeft: 'auto' }}>{a.type}</span>
      </div>
      <div style={{ fontSize: 13, color: '#e2e8f0', lineHeight: 1.5 }}>{body}</div>
    </div>
  )
}

export default function ArtifactPanel() {
  const [items, setItems] = useState([])
  const [open, setOpen] = useState(false)
  const sinceRef = useRef(0)
  const bodyRef = useRef(null)

  useEffect(() => {
    let stop = false
    const poll = async () => {
      try {
        const r = await fetch(`${SERVER}/artifacts/recent?since=${sinceRef.current}`)
        const j = await r.json()
        const fresh = (j && j.artifacts) || []
        if (fresh.length) {
          sinceRef.current = fresh[fresh.length - 1].ts
          setItems((prev) => [...prev, ...fresh].slice(-30))
          setOpen(true) // pop open when she surfaces something
        }
      } catch {}
      if (!stop) setTimeout(poll, 1500)
    }
    // start from "now" so we only show artifacts created from here on
    fetch(`${SERVER}/artifacts/recent`).then((r) => r.json()).then((j) => { sinceRef.current = (j && j.now) || Date.now() }).catch(() => {}).finally(poll)
    return () => { stop = true }
  }, [])

  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight }, [items])

  if (!items.length) return null

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{
        position: 'fixed', right: 0, top: '38%', zIndex: 9999, background: '#8b5cf6', color: 'white',
        border: 'none', borderRadius: '10px 0 0 10px', padding: '10px 8px', writingMode: 'vertical-rl',
        cursor: 'pointer', fontWeight: 700, fontSize: 12, boxShadow: '0 4px 20px rgba(0,0,0,0.4)'
      }}>Visuals ({items.length})</button>
    )
  }

  return (
    <div style={{
      position: 'fixed', right: 16, top: 16, bottom: 16, width: 420, maxWidth: '46vw', zIndex: 9999,
      background: 'rgba(15,17,26,0.92)', backdropFilter: 'blur(10px)', border: '1px solid rgba(139,92,246,0.35)',
      borderRadius: 16, boxShadow: '0 10px 40px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', color: '#e2e8f0'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <span style={{ width: 8, height: 8, borderRadius: 8, background: '#8b5cf6' }} />
        <span style={{ fontWeight: 700, fontSize: 13 }}>AVA · Visuals</span>
        <span style={{ fontSize: 11, color: '#64748b' }}>{items.length}</span>
        <button onClick={() => setItems([])} title="Clear" style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', color: '#94a3b8', borderRadius: 8, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}>Clear</button>
        <button onClick={() => setOpen(false)} title="Collapse" style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.15)', color: '#94a3b8', borderRadius: 8, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}>Hide</button>
      </div>
      <div ref={bodyRef} style={{ overflowY: 'auto', padding: 14, flex: 1 }}>
        {items.map((a, idx) => <Artifact key={a.id} a={a} n={idx + 1} />)}
      </div>
    </div>
  )
}
