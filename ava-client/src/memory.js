// Lightweight client-side memory for AVA
// - Stores interactions and tool events in localStorage
// - Provides simple hashed-bag-of-words embeddings + cosine retrieval

const KEY = 'ava_memory_v1'

function getBase() {
  try {
    const ls = (typeof localStorage !== 'undefined') ? (localStorage.getItem('AVA_SERVER_URL') || '') : ''
    if (ls) return String(ls).replace(/\/$/, '')
  } catch {}
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_AVA_SERVER_URL) {
      return String(import.meta.env.VITE_AVA_SERVER_URL).replace(/\/$/, '')
    }
  } catch {}
  return 'http://127.0.0.1:5051'
}

let BASE = getBase()
let remoteChecked = false, remoteOK = false

async function checkRemote(){
  if (remoteChecked) return remoteOK
  const tryBases = [BASE, 'http://127.0.0.1:5051']
  for (const b of tryBases) {
    if (!b) continue
    try {
      const r = await fetch(`${b}/memory/health`)
      if (r && r.ok) {
        BASE = b
        try { localStorage.setItem('AVA_SERVER_URL', BASE) } catch {}
        remoteOK = true
        remoteChecked = true
        return true
      }
    } catch {}
  }
  remoteOK = false
  remoteChecked = true
  return false
}
const D = 256 // embedding dims (hashed bow)

const stop = new Set([
  'the','a','an','and','or','but','if','then','else','for','of','on','in','to','is','are','was','were','be','been','being','i','you','he','she','it','we','they','me','my','your','our','their','this','that','these','those','with','as','at','by','from','about','into','over','after','before','so','not'
])

function tokenize(t){
  return String(t||'').toLowerCase().split(/[^a-z0-9]+/).filter(w=>w && !stop.has(w))
}

function hash(s){
  // FNV-1a 32-bit
  let h=2166136261
  for (let i=0;i<s.length;i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h>>>0)
}

function embed(text){
  const v = new Float32Array(D)
  const toks = tokenize(text)
  for (const w of toks) { const idx = hash(w) % D; v[idx] += 1 }
  // l2 normalize
  let s=0; for (let i=0;i<D;i++) s += v[i]*v[i]; s=Math.sqrt(s)||1
  for (let i=0;i<D;i++) v[i]/=s
  return Array.from(v)
}

function cos(a,b){
  let s=0; for (let i=0;i<Math.min(a.length,b.length);i++) s += a[i]*b[i]
  return s
}

function load(){
  try { return JSON.parse(localStorage.getItem(KEY)||'{}') || {} } catch { return {} }
}

function save(state){
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch {}
}

function ensure(){
  const s = load()
  if (!Array.isArray(s.interactions)) s.interactions = []
  if (!Array.isArray(s.tools)) s.tools = []
  return s
}

function uid(){ return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}` }

export function addInteraction(role, text, meta={}){
  const s = ensure()
  const item = { id: uid(), ts: Date.now(), role, text: String(text||''), rating: 0, ...meta }
  try { item.vec = embed(item.text) } catch {}
  s.interactions.push(item)
  save(s)
  return item.id
}

export async function addInteractionRemote(role, text, meta={}){
  if (!(await checkRemote())) return addInteraction(role, text, meta)
  try {
    await fetch(`${BASE}/memory/upsert`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ role, text, meta }) })
  } catch {}
  return addInteraction(role, text, meta)
}

export function logToolEvent(ev){
  const s = ensure()
  s.tools.push({ id: uid(), ts: Date.now(), ...ev })
  save(s)
}

export function rateByContent(text, rating){
  const s = ensure()
  for (let i=s.interactions.length-1;i>=0;i--){
    const it = s.interactions[i]
    if (it.role === 'bot' && it.text === text){ it.rating = Math.max(-1, Math.min(1, rating||0)); break }
  }
  save(s)
}

export async function logFeedbackRemote(text, context, liked){
  if (!(await checkRemote())) return
  try { await fetch(`${BASE}/rlhf/log`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ text, context, liked: !!liked }) }) } catch {}
}

export async function trainRewardModel(){
  if (!(await checkRemote())) return { ok:false }
  try { const r = await fetch(`${BASE}/rlhf/train`, { method:'POST' }); return await r.json() } catch { return { ok:false } }
}

export async function predictLiked(text, context){
  if (!(await checkRemote())) return { ok:false }
  try { const r = await fetch(`${BASE}/rlhf/predict`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ text, context }) }); return await r.json() } catch { return { ok:false } }
}

export async function setStylePref(action){
  if (!(await checkRemote())) return { ok:false }
  try { const r = await fetch(`${BASE}/rlhf/style`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ action }) }); return await r.json() } catch { return { ok:false } }
}

export async function getStylePref(){
  if (!(await checkRemote())) return { ok:false, pref:'concise', concise:0, detail:0 }
  try { const r = await fetch(`${BASE}/rlhf/style`); return await r.json() } catch { return { ok:false } }
}

export function summarizeTexts(texts, limit = 600){
  const s = (texts||[]).filter(Boolean).join(' | ')
  if (s.length <= limit) return s
  return s.slice(0, limit)
}

export function retrieveRelevant(query, k=5){
  const s = ensure()
  const qv = embed(query||'')
  const scored = s.interactions
    .filter(it => it.role === 'user' || it.role === 'bot')
    .map(it => ({ it, score: it.vec ? cos(qv, it.vec) : 0 }))
    .sort((a,b)=>b.score-a.score)
    .slice(0, k)
  return scored.map(x=>x.it)
}

export async function retrieveRelevantRemote(query, k=5){
  if (!(await checkRemote())) return retrieveRelevant(query, k)
  try {
    const r = await fetch(`${BASE}/memory/search`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ query, k }) })
    const j = await r.json()
    if (j?.ok) return (j.results||[]).map(x=>({ role:x.role, text:x.text, rating:x.rating, ts:x.ts }))
  } catch {}
  return retrieveRelevant(query, k)
}

export function renderPersona(){
  const s = ensure()
  const recent = s.interactions.slice(-200)
  // crude topic extraction by token frequency
  const freq = new Map()
  for (const it of recent){
    for (const w of tokenize(it.text)) freq.set(w, (freq.get(w)||0)+1)
  }
  const topics = Array.from(freq.entries()).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([w])=>w)
  const liked = recent.filter(it=>it.role==='bot' && it.rating>0).length
  const disliked = recent.filter(it=>it.role==='bot' && it.rating<0).length
  const tone = liked>=disliked ? 'concise, helpful, direct' : 'more detailed but still direct'
  const persona = `Profile: User prefers ${tone}. Frequent topics: ${topics.join(', ')}.`
  return persona
}

export async function renderPersonaAsync(){
  if (await checkRemote()) {
    try { const r = await fetch(`${BASE}/persona`); const j = await r.json(); if (j?.ok && j.persona) return j.persona } catch {}
  }
  return renderPersona()
}

export async function postTrace(payload){
  if (!(await checkRemote())) return
  try { await fetch(`${BASE}/trace`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) }) } catch {}
}

export default {
  addInteraction,
  addInteractionRemote,
  logToolEvent,
  rateByContent,
  logFeedbackRemote,
  trainRewardModel,
  predictLiked,
  setStylePref,
  getStylePref,
  summarizeTexts,
  retrieveRelevant,
  retrieveRelevantRemote,
  renderPersona,
  renderPersonaAsync,
  postTrace,
}


