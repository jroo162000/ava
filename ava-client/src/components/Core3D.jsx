import React, { useRef, useMemo, useEffect, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core3D — AVA's persistent holographic head.
// Primary avatar: ava_head_rigged.glb — her photo-derived Meshy head with 51
// ARKit blendshapes (morph targets) added by the local deformation-transfer
// pipeline in tools/blendshape-rig. When morphs are present the mouth, blinks
// and expressions are driven through them:
//   - mouth from a phoneme-class VISEME TIMELINE (tts.visemes from the voice
//     runner, grapheme->viseme estimate calibrated to real audio length; see
//     ava-integration/voice/visemes.py) anchored to the first audible frame,
//     with the tts.level amplitude envelope gating intensity — silence closes
//     the mouth even when the estimate drifts. No timeline -> falls back to
//     the old amplitude-LFO shape mix (AVA_PHONEME_VISEMES=0 reverts).
//   - autonomous eye blinks (eyeBlinkLeft/Right)
//   - state expressions via brow/eye/mouth morphs (thinking, working, speaking)
// Fallback chain: rigged GLB → plain ava_head.glb with the old PROCEDURAL jaw
// mask (onBeforeCompile ellipsoid deform) → orb scene → CSS orb.
// Head: full-range rotation via the neck bone in ava_head_rig2.glb (idle
// wander, thinking tilt, gaze tracking through window.__avaGaze(x,y) or the
// gaze.target WS event; eyes lead via eyeLook* morphs, head follows). No
// voice-driven jitter and no orbit rings - removed 2026-07-05 per Jelani.
// Perf budget: frameloop="demand" (self-invalidate ~30fps active / ~8fps idle),
// DPR clamped [1,1.5], antialias off. Auto-degrade only on sustained slow
// ACTIVE frames; idle frames and hidden-tab throttling never count as slow
// (that false positive used to kill the core after ~11s every session).
// Live mouth tuning (procedural mode): window.__avaMouth = { y, z, r, s }.
// Debug: window.__avaCore, __avaJaw, __avaFrames, __avaAmpSeen, __avaMorphs.
// ─────────────────────────────────────────────────────────────────────────────

const STATE_COLORS = {
  idle: ['#8b5cf6', '#22d3ee'],
  thinking: ['#a78bfa', '#8b5cf6'],
  speaking: ['#22d3ee', '#e0f2fe'],
  working: ['#fb923c', '#f59e0b'],
};

// Tried in order; first that loads wins.
const AVATAR_URLS = ['/avatar/ava_head_rig2.glb', '/avatar/ava_head_rigged.glb', '/avatar/ava_head.glb'];

// Every expression morph the state machine touches — anything not set by the
// current state decays back to 0 so states never leave residue on her face.
const EXPR_KEYS = [
  'browInnerUp', 'browDownLeft', 'browDownRight',
  'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight',
  'mouthPressLeft', 'mouthPressRight', 'mouthSmileLeft', 'mouthSmileRight',
];

// ── Viseme alphabet + morph recipes ─────────────────────────────────────────
// Index-paired with ava-integration/voice/visemes.py VISEMES — keep in sync.
const VISEME_NAMES = ['sil', 'PP', 'FF', 'TH', 'DD', 'KK', 'CH', 'SS', 'RR', 'AA', 'E', 'IH', 'OH', 'OU'];
const VISEME_SHAPES = [
  {},                                                                        // sil
  { mouthClose: 0.85, mouthPressLeft: 0.45, mouthPressRight: 0.45 },         // PP  p/b/m
  { mouthRollLower: 0.6, jawOpen: 0.08 },                                    // FF  f/v
  { jawOpen: 0.15, mouthFunnel: 0.2 },                                       // TH
  { jawOpen: 0.14, mouthShrugUpper: 0.15 },                                  // DD  d/t/n/l
  { jawOpen: 0.16 },                                                         // KK  k/g
  { mouthFunnel: 0.5, jawOpen: 0.12 },                                       // CH  ch/sh/j
  { jawOpen: 0.06, mouthStretchLeft: 0.35, mouthStretchRight: 0.35 },        // SS  s/z
  { mouthFunnel: 0.3, jawOpen: 0.1 },                                        // RR  r
  { jawOpen: 0.6 },                                                          // AA
  { jawOpen: 0.35, mouthStretchLeft: 0.25, mouthStretchRight: 0.25 },        // E
  { jawOpen: 0.18, mouthStretchLeft: 0.3, mouthStretchRight: 0.3 },          // IH  ee/i
  { jawOpen: 0.45, mouthFunnel: 0.55 },                                      // OH
  { jawOpen: 0.15, mouthPucker: 0.75 },                                      // OU  oo/w
];
// Union of every mouth morph either driver branch touches — all are written
// every frame so switching branches (or visemes) decays cleanly, never sticks.
const MOUTH_KEYS = [
  'jawOpen', 'mouthFunnel', 'mouthPucker', 'mouthClose',
  'mouthPressLeft', 'mouthPressRight', 'mouthRollLower', 'mouthShrugUpper',
  'mouthStretchLeft', 'mouthStretchRight',
  'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
];
// Keys only the viseme branch uses; the LFO fallback zeroes them explicitly.
const VISEME_ONLY_KEYS = [
  'mouthClose', 'mouthPressLeft', 'mouthPressRight', 'mouthRollLower',
  'mouthShrugUpper', 'mouthStretchLeft', 'mouthStretchRight',
];

const STATE_EXPR = {
  thinking: { browInnerUp: 0.4, eyeLookUpLeft: 0.35, eyeLookUpRight: 0.35, mouthPressLeft: 0.25, mouthPressRight: 0.25 },
  working: { browDownLeft: 0.3, browDownRight: 0.3, eyeSquintLeft: 0.18, eyeSquintRight: 0.18 },
  speaking: { mouthSmileLeft: 0.12, mouthSmileRight: 0.12, browInnerUp: 0.08 },
  idle: { mouthSmileLeft: 0.06, mouthSmileRight: 0.06 },
};

const CORE_VERT = `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  uniform float time;
  uniform float amp;
  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = -mvPosition.xyz;
    vec3 pos = position + normal * sin(position.y * 10.0 + time * 5.0) * (0.05 + amp * 0.18);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const CORE_FRAG = `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  uniform float time;
  uniform vec3 color;
  void main() {
    vec3 normal = normalize(vNormal);
    vec3 viewDir = normalize(vViewPosition);
    float fresnel = pow(clamp(1.0 - dot(viewDir, normal), 0.0, 1.0), 3.0);
    float grid = sin(vUv.x * 50.0 + time) * sin(vUv.y * 50.0 - time);
    grid = step(0.9, grid);
    vec3 finalColor = color * (fresnel * 2.0 + grid * 0.5);
    gl_FragColor = vec4(finalColor, fresnel + grid * 0.5);
  }
`;

const SHELL_VERT = `
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const SHELL_FRAG = `
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  uniform vec3 color;
  void main() {
    vec3 normal = normalize(vNormal);
    vec3 viewDir = normalize(vViewPosition);
    float fresnel = pow(clamp(1.0 - dot(viewDir, normal), 0.0, 1.0), 2.5);
    gl_FragColor = vec4(color * fresnel * 1.6, fresnel * 0.55);
  }
`;

// Shared demand-loop: ~30fps active, ~8fps idle. paceRef mirrors the interval we
// asked for so the slow-frame detector can tell "idle by design" from "GPU
// struggling" — only active-pace frames may count as slow.
function useDemandLoop(stateRef, ampRef, paceRef) {
  const { invalidate } = useThree();
  useEffect(() => {
    let alive = true;
    let t;
    const tick = () => {
      if (!alive) return;
      invalidate();
      const s = stateRef.current;
      const active = s === 'speaking' || s === 'working' || s === 'thinking' || (ampRef.current | 0) > 60;
      if (paceRef) paceRef.current = active ? 33 : 125;
      t = setTimeout(tick, active ? 33 : 125);
    };
    tick();
    return () => { alive = false; clearTimeout(t); };
  }, [invalidate, stateRef, ampRef, paceRef]);
}

// ── AVATAR SCENE — her head as the persistent hologram ──────────────────────
function AvatarScene({ stateRef, ampRef, visemeRef, gazeRef, poseRef, gestureRef, exprRef, torsoRef, onDegrade, onFail }) {
  const headGroup = useRef();
  const bobRef = useRef();
  const headBone = useRef(null);         // neck joint in ava_head_rig2.glb
  const torsoBone = useRef(null);        // root joint (lean_in gesture)
  const exprUsed = useRef(new Set());    // morphs her expressions have touched (for clean decay)
  const ampPeak = useRef(6000);          // adaptive loudness reference (Piper is hot, Kokoro is natural)
  const pulseMesh = useRef();
  const pulseMat = useRef();
  const [model, setModel] = useState(null);
  const morph = useRef(null);            // { inf, dict } when the GLB has ARKit morphs
  const blink = useRef({ next: 3, at: -1 });
  const jaw = useRef(0);
  const intensity = useRef(0);
  const slowFrames = useRef(0);
  const paceRef = useRef(125);
  const colA = useMemo(() => new THREE.Color(), []);
  const colB = useMemo(() => new THREE.Color(), []);
  const uJaw = useMemo(() => ({ value: 0 }), []);
  const uMouth = useMemo(() => ({ value: new THREE.Vector4(0, 0, 1, 0) }), []);
  const shellMaterial = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color('#0ea5e9') } },
    vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG,
    transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
  }), []);

  useDemandLoop(stateRef, ampRef, paceRef);

  useEffect(() => {
    let dead = false;
    const loader = new GLTFLoader();
    const tryLoad = (i) => {
      if (dead) return;
      if (i >= AVATAR_URLS.length) { onFail && onFail('all avatar URLs failed'); return; }
      loader.load(AVATAR_URLS[i], (gltf) => {
        if (dead) return;
        try {
          let mesh = null;
          gltf.scene.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
          if (!mesh) { onFail && onFail('no mesh in GLB'); return; }
          mesh.geometry.computeBoundingBox();
          const bb = mesh.geometry.boundingBox;
          const size = new THREE.Vector3(); bb.getSize(size);
          const center = new THREE.Vector3(); bb.getCenter(center);
          const h = size.y || 1;
          const dict = mesh.morphTargetDictionary;
          const hasMorphs = !!(dict && dict.jawOpen !== undefined && mesh.morphTargetInfluences);
          if (hasMorphs) {
            // ARKit blendshape mode — the morph driver in useFrame does the work.
            morph.current = { inf: mesh.morphTargetInfluences, dict };
          } else {
            // Procedural fallback — inject the ellipsoid jaw mask into her material.
            // Mouth region (geometry-local); bust proportions put it high in the
            // bbox. Tunable live via window.__avaMouth = {y,z,r,s}.
            const ov = (typeof window !== 'undefined' && window.__avaMouth) || {};
            uMouth.value.set(
              ov.y !== undefined ? ov.y : bb.min.y + h * 0.62,
              ov.z !== undefined ? ov.z : center.z + (size.z || 1) * 0.38,
              ov.r !== undefined ? ov.r : h * 0.105,
              ov.s !== undefined ? ov.s : h * 0.04
            );
            const mat = mesh.material;
            mat.onBeforeCompile = (shader) => {
              shader.uniforms.uJaw = uJaw;
              shader.uniforms.uMouth = uMouth;
              shader.vertexShader = `
                uniform float uJaw;
                uniform vec4 uMouth;
              ` + shader.vertexShader.replace('#include <begin_vertex>', `
                #include <begin_vertex>
                {
                  vec3 mrel = (position - vec3(0.0, uMouth.x, uMouth.y)) * vec3(1.0, 1.55, 1.15);
                  float mMask = 1.0 - smoothstep(uMouth.z * 0.35, uMouth.z, length(mrel));
                  transformed.y -= uJaw * mMask * uMouth.w;
                  transformed.z -= uJaw * mMask * uMouth.w * 0.3;
                }
              `);
            };
            mat.needsUpdate = true;
          }
          let hbFound = null;
          let tbFound = null;
          gltf.scene.traverse((o) => {
            if (!o.isBone) return;
            if (o.name === 'Head') hbFound = o;
            if (o.name === 'Torso') tbFound = o;
          });
          headBone.current = hbFound;
          torsoBone.current = tbFound;
          const s = 3.1 / h;
          gltf.scene.position.set(-center.x * s, -center.y * s, -center.z * s);
          gltf.scene.scale.setScalar(s);
          const shell = new THREE.Mesh(mesh.geometry, shellMaterial);
          shell.position.copy(gltf.scene.position);
          shell.scale.copy(gltf.scene.scale).multiplyScalar(1.015);
          const holder = new THREE.Group();
          holder.add(gltf.scene);
          holder.add(shell);
          try {
            window.__avaCore = {
              loaded: true, url: AVATAR_URLS[i], size: size.toArray(), scale: s,
              morphs: hasMorphs ? Object.keys(dict).length : 0,
              mode: hasMorphs ? 'blendshapes' : 'procedural',
            };
          } catch { /* debug */ }
          setModel(holder);
        } catch (e) {
          console.warn('[Core3D] avatar prepare failed:', e);
          try { window.__avaCore = { error: 'prepare: ' + e.message }; } catch { /* debug */ }
          onFail && onFail(e.message);
        }
      }, undefined, (err) => {
        if (!dead) {
          console.warn('[Core3D] avatar load failed:', AVATAR_URLS[i], err);
          tryLoad(i + 1);
        }
      });
    };
    tryLoad(0);
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame((st, delta) => {
    // auto-degrade only on sustained slow ACTIVE frames, never idle/hidden-tab.
    if (paceRef.current === 33 && delta > 0.05 && delta < 2 && !document.hidden) {
      slowFrames.current += 1;
      if (slowFrames.current > 90) { onDegrade && onDegrade('slow frames'); return; }
    } else if (delta <= 0.05 || paceRef.current !== 33) {
      slowFrames.current = Math.max(0, slowFrames.current - 2);
    }

    const time = st.clock.getElapsedTime();
    const s = stateRef.current || 'idle';
    const rawAmp = ampRef.current | 0;
    // Engines differ wildly in loudness (Piper rms ~13k, Kokoro ~5k): track a
    // slowly-decaying peak so the jaw envelope self-scales to whatever plays.
    ampPeak.current = Math.max(ampPeak.current * 0.9995, rawAmp, 3500);
    const amp = Math.min(rawAmp / (ampPeak.current * 0.75), 1);
    const target = s === 'speaking' ? Math.max(0.5, amp) : s === 'working' ? 0.55 : s === 'thinking' ? 0.7 : 0;
    intensity.current = THREE.MathUtils.lerp(intensity.current, target, Math.min(delta * 5, 1));

    const rate = amp > jaw.current ? 18 : 6;
    jaw.current = THREE.MathUtils.lerp(jaw.current, amp, Math.min(delta * rate, 1));
    const flutter = 0.55 + 0.45 * Math.abs(Math.sin(time * 11.7) * Math.sin(time * 6.3));
    uJaw.value = jaw.current * flutter;
    try { window.__avaJaw = uJaw.value; window.__avaFrames = (window.__avaFrames || 0) + 1; window.__avaAmpSeen = ampRef.current | 0; } catch { /* debug */ }

    // ── ARKit blendshape driver ──────────────────────────────────────────────
    const m = morph.current;
    if (m) {
      const { inf, dict } = m;
      const k = Math.min(delta * 12, 1);
      const set = (name, v) => {
        const i = dict[name];
        if (i !== undefined) inf[i] += (v - inf[i]) * k;
      };
      // Mouth. Preferred: the phoneme-class viseme timeline (tts.visemes,
      // clock anchored in Stage.jsx to the first audible tts.level frame).
      // The amplitude envelope GATES intensity, so silence closes the mouth
      // even when the estimated timing drifts. No live timeline -> the old
      // amplitude-LFO articulation mix.
      const jawV = uJaw.value;
      const vt = visemeRef ? visemeRef.current : null;
      let vshape = null;
      if (vt && vt.started) {
        const tMs = performance.now() - vt.started;
        if (tMs <= (vt.est | 0) + 600) {
          const ev = vt.v;
          let cur = 0;
          while (cur + 1 < ev.length && ev[cur + 1][0] <= tMs) cur++;
          let idx = ev[cur][1];
          // a sil shorter than 90ms between shapes reads as flicker - hold through it
          if (idx === 0 && cur > 0 && cur + 1 < ev.length && (ev[cur + 1][0] - ev[cur][0]) < 90) idx = ev[cur - 1][1];
          vshape = VISEME_SHAPES[idx] || null;
          // coarticulation: pre-blend the next shape over its last 60ms of lead-in
          if (vshape && cur + 1 < ev.length) {
            const nxt = ev[cur + 1];
            const lead = nxt[0] - tMs;
            if (lead >= 0 && lead < 60 && nxt[1] !== idx) {
              const nb = VISEME_SHAPES[nxt[1]] || {};
              const f = (1 - lead / 60) * 0.5;
              const mix = {};
              for (let i = 0; i < MOUTH_KEYS.length; i++) {
                const mk = MOUTH_KEYS[i];
                mix[mk] = (vshape[mk] || 0) * (1 - f) + (nb[mk] || 0) * f;
              }
              vshape = mix;
            }
          }
          vt.name = VISEME_NAMES[idx] || '?';
        } else if (jawV < 0.02) {
          visemeRef.current = null;    // exhausted and mouth settled — release
        }
      }
      if (vshape) {
        // Floor keeps consonant closures visible between amplitude peaks;
        // jawV tracks the real envelope so pauses still shut the mouth.
        const gain = Math.min(0.35 + jawV * 1.1, 1);
        for (let i = 0; i < MOUTH_KEYS.length; i++) {
          set(MOUTH_KEYS[i], (vshape[MOUTH_KEYS[i]] || 0) * gain);
        }
      } else {
        const shapeMix = 0.5 + 0.5 * Math.sin(time * 1.7 + Math.sin(time * 0.9) * 2.0);
        set('jawOpen', jawV * 0.8);
        set('mouthFunnel', jawV * 0.45 * shapeMix);
        set('mouthPucker', jawV * 0.22 * (1 - shapeMix));
        set('mouthLowerDownLeft', jawV * 0.3);
        set('mouthLowerDownRight', jawV * 0.3);
        set('mouthUpperUpLeft', jawV * 0.18);
        set('mouthUpperUpRight', jawV * 0.18);
        for (let i = 0; i < VISEME_ONLY_KEYS.length; i++) set(VISEME_ONLY_KEYS[i], 0);
      }
      // Autonomous blinks (instant, not smoothed — real blinks are fast).
      const b = blink.current;
      if (b.at < 0 && time >= b.next) b.at = time;
      let blinkV = 0;
      if (b.at >= 0) {
        const t = time - b.at;
        blinkV = t < 0.1 ? t / 0.1 : t < 0.25 ? 1 - (t - 0.1) / 0.15 : 0;
        if (t >= 0.25) { b.at = -1; b.next = time + 2 + Math.random() * 4; }
      }
      if (dict.eyeBlinkLeft !== undefined) inf[dict.eyeBlinkLeft] = blinkV;
      if (dict.eyeBlinkRight !== undefined) inf[dict.eyeBlinkRight] = blinkV;
      // Gaze -> eyes (eyes lead fully; the head bone follows at ~60% above).
      const gzE = gazeRef ? gazeRef.current : null;
      const gzFresh = gzE && (performance.now() - gzE.at) < (gzE.hold || 3000);
      const gx = gzFresh ? Math.max(-1, Math.min(1, gzE.x)) : 0;
      const gy = gzFresh ? Math.max(-1, Math.min(1, gzE.y)) : 0;
      set('eyeLookOutRight', Math.max(gx, 0)); set('eyeLookInLeft', Math.max(gx, 0));
      set('eyeLookOutLeft', Math.max(-gx, 0)); set('eyeLookInRight', Math.max(-gx, 0));
      set('eyeLookUpLeft', Math.max(gy, 0)); set('eyeLookUpRight', Math.max(gy, 0));
      set('eyeLookDownLeft', Math.max(-gy, 0)); set('eyeLookDownRight', Math.max(-gy, 0));
      // State expressions; untouched keys decay to 0.
      const expr = STATE_EXPR[s] || STATE_EXPR.idle;
      for (let i = 0; i < EXPR_KEYS.length; i++) set(EXPR_KEYS[i], expr[EXPR_KEYS[i]] || 0);
      // Intentional expression from avatar_body — HER deliberate face, wins over
      // state expressions. Mouth keys yield to live visemes while she speaks;
      // everything her expressions ever touched decays cleanly back to 0.
      const ex = exprRef ? exprRef.current : null;
      const exOn = ex && performance.now() < ex.until;
      if (exOn) {
        for (const k3 in ex.morphs) {
          if (dict[k3] !== undefined) exprUsed.current.add(k3);
        }
      }
      if (exprUsed.current.size) {
        let residue = false;
        exprUsed.current.forEach((k3) => {
          if (vshape && MOUTH_KEYS.indexOf(k3) >= 0) return;
          const v = exOn && ex.morphs[k3] !== undefined ? Math.max(0, Math.min(1, +ex.morphs[k3] || 0)) : 0;
          set(k3, v);
          const i3 = dict[k3];
          if (i3 !== undefined && inf[i3] > 0.01) residue = true;
        });
        if (!exOn && !residue) exprUsed.current.clear();
      }
      try { window.__avaMorphs = { jaw: inf[dict.jawOpen], blink: blinkV, mode: s, viseme: vshape ? vt.name : null, chunk: vt ? vt.chunk : 0 }; } catch { /* debug */ }
    }

    // Head. Full range through the neck bone when the rig has one; gentle
    // whole-group sway as fallback. NO voice-coupled jitter in either path.
    const gz = gazeRef ? gazeRef.current : null;
    const gzOn = gz && (performance.now() - gz.at) < ((gz && gz.hold) || 3000);
    const pv = poseRef ? poseRef.current : null;
    const poseOn = pv && performance.now() < pv.until;
    // One-shot gestures (nod/shake/tilt/lean_in/look_away) overlay whatever
    // the base target is — hers via avatar_body, ~1.5s, eased in and out.
    let gy = 0, gp = 0, gr = 0, lean = 0;
    const gst = gestureRef ? gestureRef.current : null;
    if (gst) {
      const gt = (performance.now() - gst.t0) / 1000;
      if (gt > 1.6) {
        gestureRef.current = null;
      } else {
        const env = Math.sin(Math.min(gt / 1.5, 1) * Math.PI);
        if (gst.name === 'nod') gp += Math.sin(gt * 2 * Math.PI / 0.7) * 0.12 * env;
        else if (gst.name === 'shake') gy += Math.sin(gt * 2 * Math.PI / 0.8) * 0.16 * env;
        else if (gst.name === 'tilt') gr += 0.18 * env;
        else if (gst.name === 'look_away') { gy += 0.42 * env; gp += 0.06 * env; }
        else if (gst.name === 'lean_in') { gp -= 0.08 * env; lean = 0.07 * env; }
      }
    }
    const tb = torsoBone.current;
    if (tb) {
      // Torso: her deliberate pose > gesture lean > breathing baseline. The
      // breath is body-life, not a decision — every living body has it.
      const tv = torsoRef ? torsoRef.current : null;
      const tOn = tv && performance.now() < tv.until;
      // Visible body life: breath + a slow weight-shift sway. (First cut was
      // 0.012 rad — sub-pixel at Stage size; "the torso is still frozen".)
      const breath = Math.sin(time * 0.85) * 0.02;
      const sway = Math.sin(time * 0.09) * 0.06 + Math.sin(time * 0.031) * 0.03;
      const shoulder = Math.sin(time * 0.13 + 0.8) * 0.018;
      const tx = (tOn ? tv.pitch : 0) + lean + breath;
      const tyw = (tOn ? tv.yaw : sway);
      const trl = tOn ? tv.roll : shoulder;
      const tk = Math.min(delta * (tOn ? 4 : 1.5), 1);
      tb.rotation.x = THREE.MathUtils.lerp(tb.rotation.x, tx, tk);
      tb.rotation.y = THREE.MathUtils.lerp(tb.rotation.y, tyw, tk);
      tb.rotation.z = THREE.MathUtils.lerp(tb.rotation.z, trl, tk);
    }
    const hb = headBone.current;
    if (hb) {
      let ty, tp, tr = 0;
      if (poseOn) {
        ty = pv.yaw; tp = pv.pitch; tr = pv.roll;
      } else if (gzOn) {
        ty = Math.max(-1, Math.min(1, gz.x)) * 0.55;
        tp = Math.max(-1, Math.min(1, -gz.y)) * 0.35;
      } else {
        ty = Math.sin(time * 0.13) * 0.28 + Math.sin(time * 0.047) * 0.12;
        tp = Math.sin(time * 0.11 + 1.7) * 0.08;
        if (s === 'thinking') { tr = 0.12; tp -= 0.10; ty = Math.sin(time * 0.3) * 0.18; }
        if (s === 'speaking') { tp += Math.sin(time * 0.6) * 0.05; }
      }
      ty += gy; tp += gp; tr += gr;
      const hk = Math.min(delta * ((poseOn || gzOn || gst) ? 7 : 2.2), 1);
      hb.rotation.y = THREE.MathUtils.lerp(hb.rotation.y, ty, hk);
      hb.rotation.x = THREE.MathUtils.lerp(hb.rotation.x, tp, hk);
      hb.rotation.z = THREE.MathUtils.lerp(hb.rotation.z, tr, Math.min(delta * 2, 1));
      try { window.__avaHead = { yaw: +hb.rotation.y.toFixed(3), pitch: +hb.rotation.x.toFixed(3), roll: +hb.rotation.z.toFixed(3), gaze: gzOn ? [gz.x, gz.y] : null, mode: poseOn ? 'pose' : (gzOn ? 'gaze' : 'idle'), gesture: gst ? gst.name : null, torso: tb ? { yaw: +tb.rotation.y.toFixed(3), pitch: +tb.rotation.x.toFixed(3), own: !!tOn } : 'BONE NOT FOUND' }; } catch { /* debug */ }
    } else if (headGroup.current) {
      const g = headGroup.current;
      const rx = Math.sin(time * 0.35) * 0.02;
      const ry = Math.sin(time * 0.45) * 0.07;
      const rz = s === 'thinking' ? 0.09 : 0;
      g.rotation.x = THREE.MathUtils.lerp(g.rotation.x, rx, Math.min(delta * 6, 1));
      g.rotation.y = THREE.MathUtils.lerp(g.rotation.y, ry, Math.min(delta * 6, 1));
      g.rotation.z = THREE.MathUtils.lerp(g.rotation.z, rz, Math.min(delta * 4, 1));
    }
    if (bobRef.current) bobRef.current.position.y = Math.sin(time * 0.9) * 0.05;

    const [a, b] = STATE_COLORS[s] || STATE_COLORS.idle;
    colA.set(a); colB.set(b);
    shellMaterial.uniforms.color.value.copy(colA).lerp(colB, 0.5);
    if (pulseMesh.current && pulseMat.current) {
      if (amp > 0.02) {
        const scale = 1 + ((time * 2) % 1.5);
        pulseMesh.current.scale.setScalar(scale);
        pulseMat.current.opacity = Math.max(0, 1 - (scale - 1) / 1.5) * 0.3 * Math.max(amp, 0.4);
      } else {
        pulseMat.current.opacity = 0;
      }
    }
  });

  return (
    <group ref={bobRef}>
      <hemisphereLight args={['#cfe8ff', '#1e1b4b', 1.15]} />
      <directionalLight position={[1.5, 3, 4]} intensity={2.0} />
      <pointLight position={[0, -2.5, 2]} intensity={0.5} color="#22d3ee" />
      <mesh ref={pulseMesh}>
        <sphereGeometry args={[1.7, 24, 24]} />
        <meshBasicMaterial ref={pulseMat} color="#38bdf8" transparent opacity={0} side={THREE.BackSide} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <group ref={headGroup}>
        {model ? <primitive object={model} /> : null}
      </group>
    </group>
  );
}

// ── ORB SCENE — the original core, kept as the fallback ─────────────────────
function CoreScene({ stateRef, ampRef, onDegrade }) {
  const groupRef = useRef();
  const ring1 = useRef();
  const ring2 = useRef();
  const pulseMesh = useRef();
  const pulseMat = useRef();
  const bobRef = useRef();
  const intensity = useRef(0);
  const slowFrames = useRef(0);
  const paceRef = useRef(125);
  const colA = useMemo(() => new THREE.Color(), []);
  const colB = useMemo(() => new THREE.Color(), []);

  const coreMaterial = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, amp: { value: 0 }, color: { value: new THREE.Color('#22d3ee') } },
    vertexShader: CORE_VERT, fragmentShader: CORE_FRAG,
    transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false,
  }), []);
  const shellMaterial = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color('#0ea5e9') } },
    vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG,
    transparent: true, blending: THREE.AdditiveBlending, side: THREE.FrontSide, depthWrite: false,
  }), []);

  useDemandLoop(stateRef, ampRef, paceRef);

  useFrame((st, delta) => {
    if (paceRef.current === 33 && delta > 0.05 && delta < 2 && !document.hidden) {
      slowFrames.current += 1;
      if (slowFrames.current > 90) { onDegrade && onDegrade('slow frames'); return; }
    } else if (delta <= 0.05 || paceRef.current !== 33) {
      slowFrames.current = Math.max(0, slowFrames.current - 2);
    }

    const time = st.clock.getElapsedTime();
    const s = stateRef.current || 'idle';
    const amp = Math.min(((ampRef.current | 0)) / 9000, 1);
    const target = s === 'speaking' ? Math.max(0.5, amp) : s === 'working' ? 0.55 : s === 'thinking' ? 0.7 : 0;
    intensity.current = THREE.MathUtils.lerp(intensity.current, target, Math.min(delta * 5, 1));
    const speedMult = 1.0 + intensity.current * 4.0;

    if (groupRef.current) groupRef.current.rotation.y += delta * 0.2 * speedMult;
    if (bobRef.current) bobRef.current.position.y = Math.sin(time * (1 + intensity.current)) * 0.08;

    const [a, b] = STATE_COLORS[s] || STATE_COLORS.idle;
    colA.set(a); colB.set(b);
    coreMaterial.uniforms.time.value = time * speedMult;
    coreMaterial.uniforms.amp.value = amp;
    coreMaterial.uniforms.color.value.copy(colA).lerp(colB, 0.3 + intensity.current * 0.5);
    shellMaterial.uniforms.color.value.copy(colA).lerp(colB, 0.5);

    if (ring1.current) {
      ring1.current.rotation.x += delta * 0.5 * speedMult;
      ring1.current.rotation.y += delta * 0.3 * speedMult;
      ring1.current.material.opacity = 0.5 + intensity.current * 0.5;
    }
    if (ring2.current) {
      ring2.current.rotation.y -= delta * 0.4 * speedMult;
      ring2.current.rotation.z += delta * 0.6 * speedMult;
    }
    if (pulseMesh.current && pulseMat.current) {
      if (amp > 0.02) {
        const scale = 1 + ((time * 2) % 1.5);
        pulseMesh.current.scale.setScalar(scale);
        pulseMat.current.opacity = Math.max(0, 1 - (scale - 1) / 1.5) * 0.3 * Math.max(amp, 0.4);
      } else {
        pulseMat.current.opacity = 0;
      }
    }
  });

  return (
    <group ref={bobRef}>
      <mesh ref={pulseMesh}>
        <sphereGeometry args={[1.5, 24, 24]} />
        <meshBasicMaterial ref={pulseMat} color="#38bdf8" transparent opacity={0} side={THREE.BackSide} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <group ref={groupRef}>
        <mesh>
          <sphereGeometry args={[1.2, 48, 48]} />
          <primitive object={coreMaterial} attach="material" />
        </mesh>
        <mesh ref={ring1} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[2.5, 0.02, 12, 64]} />
          <meshBasicMaterial color="#0088ff" transparent opacity={0.6} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
        <mesh ref={ring2} rotation={[Math.PI / 3, Math.PI / 4, 0]}>
          <torusGeometry args={[2.8, 0.015, 12, 64]} />
          <meshBasicMaterial color="#22d3ee" transparent opacity={0.4} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
        <mesh>
          <sphereGeometry args={[1.6, 48, 48]} />
          <primitive object={shellMaterial} attach="material" />
        </mesh>
      </group>
    </group>
  );
}

export default function Core3D({ stateRef, ampRef, visemeRef, gazeRef, poseRef, gestureRef, exprRef, torsoRef, onDegrade }) {
  const [dead, setDead] = useState(false);
  const [avatarOk, setAvatarOk] = useState(true);
  if (dead) return null;   // Stage renders the CSS orb when we bail
  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 1.5]}
      gl={{ antialias: false, alpha: true, powerPreference: 'low-power' }}
      camera={{ position: [0, 0, 6], fov: 45 }}
      style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener('webglcontextlost', () => { setDead(true); onDegrade && onDegrade('context lost'); }, { once: true });
      }}
      fallback={null}
    >
      {avatarOk
        ? <AvatarScene stateRef={stateRef} ampRef={ampRef} visemeRef={visemeRef} gazeRef={gazeRef} poseRef={poseRef} gestureRef={gestureRef} exprRef={exprRef} torsoRef={torsoRef} onFail={() => setAvatarOk(false)} onDegrade={(why) => { setDead(true); onDegrade && onDegrade(why); }} />
        : <CoreScene stateRef={stateRef} ampRef={ampRef} onDegrade={(why) => { setDead(true); onDegrade && onDegrade(why); }} />}
    </Canvas>
  );
}
