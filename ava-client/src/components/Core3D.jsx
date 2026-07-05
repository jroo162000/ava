import React, { useRef, useMemo, useEffect, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core3D — Tier 3 #17b: the holographic core, ported from ava-ui-3d's
// HolographicHead.tsx under the UI_MERGE_PLAN §7 performance budget:
//   - NO drei, NO postprocessing, NO MeshTransmissionMaterial (the glass shell is
//     a cheap fresnel-only shader — visually ~90% of the transmission look)
//   - frameloop="demand": we invalidate ourselves at ~30fps while active
//     (speaking/working/thinking) and ~8fps while idle
//   - DPR clamped to [1, 1.5], antialias off, small geometry counts
//   - auto-degrade: sustained slow frames (or any WebGL/render error) calls
//     onDegrade() and the Stage falls back to the CSS orb for the session
// Signals are REAL: `state` is the Stage's event-driven state machine and
// `ampRef.current` is her live speech amplitude (tts.level rms, ~10Hz).
//
// 2026-07-03 — AVATAR CORE (Jelani): the persistent hologram is now HER —
// ava_head.glb (the model Jelani provided) loaded as the Stage centerpiece,
// with PROCEDURAL speech animation: the mouth/jaw region of the mesh deforms
// with her real TTS amplitude (fast-attack / slow-release envelope + syllabic
// flutter), state-driven head motion (idle sway, thinking tilt, speaking nods,
// working tremor) and a state-colored fresnel rim. The GLB is a static mesh
// (no rig / no blendshapes — eyes and lips are painted into the texture), so
// this is amplitude lip-motion, NOT phoneme visemes, and there are no true
// eyelid blinks. If the model fails to load or WebGL struggles, we fall back
// to the original orb (CoreScene) and then the CSS orb, as before.
// Live tuning: window.__avaMouth = { y, z, r, s } (geometry-local overrides).
// ─────────────────────────────────────────────────────────────────────────────

const STATE_COLORS = {
  idle: ['#8b5cf6', '#22d3ee'],
  thinking: ['#a78bfa', '#8b5cf6'],
  speaking: ['#22d3ee', '#e0f2fe'],
  working: ['#fb923c', '#f59e0b'],
};

const AVATAR_URL = '/avatar/ava_head.glb';

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
    // pulsing distortion — base motion plus HER real speech amplitude
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

// Shared demand-loop: ~30fps while active, ~8fps idle (perf budget). paceRef mirrors the
// interval we ASKED for, so the slow-frame detector can tell "idle by design" from "GPU
// struggling" — the old detector treated every intentional 125ms idle frame as slow and
// self-degraded the 3D core to the CSS orb after ~11s of idle, every session. That was the
// hidden reason the hologram "didn't stay on the UI".
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
function AvatarScene({ stateRef, ampRef, onDegrade, onFail }) {
  const headGroup = useRef();     // state-driven head motion (rotation)
  const bobRef = useRef();        // gentle whole-core bob
  const ring1 = useRef();
  const ring2 = useRef();
  const pulseMesh = useRef();
  const pulseMat = useRef();
  const [model, setModel] = useState(null);
  const jaw = useRef(0);          // smoothed speech envelope (0..1)
  const intensity = useRef(0);
  const slowFrames = useRef(0);
  const paceRef = useRef(125);    // what the demand loop asked for (33 active / 125 idle)
  const colA = useMemo(() => new THREE.Color(), []);
  const colB = useMemo(() => new THREE.Color(), []);
  // uniforms shared with the injected jaw shader + rim shell
  const uJaw = useMemo(() => ({ value: 0 }), []);
  const uMouth = useMemo(() => ({ value: new THREE.Vector4(0, 0, 1, 0) }), []); // x: mouthY, y: mouthZ, z: radius, w: strength
  const shellMaterial = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color('#0ea5e9') } },
    vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG,
    transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
  }), []);

  useDemandLoop(stateRef, ampRef, paceRef);

  // Load + prepare the GLB once: center, scale, face the camera, inject the
  // jaw deformation into the model's own material (texture stays intact).
  useEffect(() => {
    let dead = false;
    const loader = new GLTFLoader();
    loader.load(AVATAR_URL, (gltf) => {
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
        // Mouth region estimate (geometry-local). The model is a BUST (head + shoulders/
        // sweater), so the mouth sits ~62% up the full bounding box, not in the lower third
        // (0.32h landed on her chest). Tunable live via window.__avaMouth = {y,z,r,s}.
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
            // amplitude lip-motion: pull the mouth/jaw region down + slightly in
            // while she speaks (mask is an ellipsoid around the mouth estimate,
            // wider than tall, front-of-face only).
            {
              vec3 mrel = (position - vec3(0.0, uMouth.x, uMouth.y)) * vec3(1.0, 1.55, 1.15);
              float mMask = 1.0 - smoothstep(uMouth.z * 0.35, uMouth.z, length(mrel));
              transformed.y -= uJaw * mMask * uMouth.w;
              transformed.z -= uJaw * mMask * uMouth.w * 0.3;
            }
          `);
        };
        mat.needsUpdate = true;
        // Normalize presentation: center at origin, height ≈ 3.1 world units.
        const s = 3.1 / h;
        gltf.scene.position.set(-center.x * s, -center.y * s, -center.z * s);
        gltf.scene.scale.setScalar(s);
        // Rim shell: a slightly inflated clone of the head with the fresnel shader.
        const shell = new THREE.Mesh(mesh.geometry, shellMaterial);
        shell.position.copy(gltf.scene.position);
        shell.scale.copy(gltf.scene.scale).multiplyScalar(1.015);
        const holder = new THREE.Group();
        holder.add(gltf.scene);
        holder.add(shell);
        try { window.__avaCore = { loaded: true, size: size.toArray(), center: center.toArray(), scale: s, matType: mat.type, mouth: uMouth.value.toArray() }; } catch { /* debug only */ }
        setModel(holder);
      } catch (e) {
        console.warn('[Core3D] avatar prepare failed:', e);
        try { window.__avaCore = { error: 'prepare: ' + e.message }; } catch { /* debug only */ }
        onFail && onFail(e.message);
      }
    }, undefined, (err) => {
      if (!dead) {
        console.warn('[Core3D] avatar load failed:', err);
        try { window.__avaCore = { error: 'load: ' + String(err && err.message || err) }; } catch { /* debug only */ }
        onFail && onFail(String(err && err.message || err));
      }
    });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame((st, delta) => {
    // auto-degrade: sustained slow frames WHILE ACTIVE -> hand back to the CSS orb.
    // Idle frames arrive at an intentional 125ms cadence (paceRef 125) and must never
    // count as slow — that false positive silently killed the 3D core after ~11s idle.
    if (paceRef.current === 33 && delta > 0.05 && delta < 2) {
      slowFrames.current += 1;
      if (slowFrames.current > 90) { onDegrade && onDegrade('slow frames'); return; }
    } else if (delta <= 0.05 || paceRef.current !== 33) {
      slowFrames.current = Math.max(0, slowFrames.current - 2);
    }

    const time = st.clock.getElapsedTime();
    const s = stateRef.current || 'idle';
    const amp = Math.min(((ampRef.current | 0)) / 7000, 1);
    const target = s === 'speaking' ? Math.max(0.5, amp) : s === 'working' ? 0.55 : s === 'thinking' ? 0.7 : 0;
    intensity.current = THREE.MathUtils.lerp(intensity.current, target, Math.min(delta * 5, 1));

    // Speech envelope: fast attack, slower release — reads as natural mouth energy.
    const rate = amp > jaw.current ? 18 : 6;
    jaw.current = THREE.MathUtils.lerp(jaw.current, amp, Math.min(delta * rate, 1));
    // Syllabic flutter so sustained loudness still articulates open/close cycles.
    const flutter = 0.55 + 0.45 * Math.abs(Math.sin(time * 11.7) * Math.sin(time * 6.3));
    uJaw.value = jaw.current * flutter;
    try { window.__avaJaw = uJaw.value; window.__avaFrames = (window.__avaFrames || 0) + 1; window.__avaAmpSeen = ampRef.current | 0; } catch { /* debug only */ }

    // State-driven head motion (the "expressions" this rig-less mesh can honestly do):
    // idle = slow sway; thinking = tilt + look slightly up; speaking = micro-nods
    // with her voice; working = quick small tremor.
    if (headGroup.current) {
      const g = headGroup.current;
      let rx = Math.sin(time * 0.35) * 0.02;
      let ry = Math.sin(time * 0.45) * 0.07;
      let rz = 0;
      if (s === 'thinking') { rz = 0.09; rx -= 0.05; ry = Math.sin(time * 0.8) * 0.1; }
      if (s === 'speaking') { rx += uJaw.value * 0.045 * Math.sin(time * 9.0); ry += Math.sin(time * 1.2) * 0.03; }
      if (s === 'working') { ry += Math.sin(time * 14.0) * 0.008; }
      g.rotation.x = THREE.MathUtils.lerp(g.rotation.x, rx, Math.min(delta * 6, 1));
      g.rotation.y = THREE.MathUtils.lerp(g.rotation.y, ry, Math.min(delta * 6, 1));
      g.rotation.z = THREE.MathUtils.lerp(g.rotation.z, rz, Math.min(delta * 4, 1));
    }
    if (bobRef.current) bobRef.current.position.y = Math.sin(time * (1 + intensity.current)) * 0.06;

    const [a, b] = STATE_COLORS[s] || STATE_COLORS.idle;
    colA.set(a); colB.set(b);
    shellMaterial.uniforms.color.value.copy(colA).lerp(colB, 0.5);
    const speedMult = 1.0 + intensity.current * 3.0;
    if (ring1.current) {
      ring1.current.rotation.x += delta * 0.5 * speedMult;
      ring1.current.rotation.y += delta * 0.3 * speedMult;
      ring1.current.material.opacity = 0.4 + intensity.current * 0.5;
    }
    if (ring2.current) {
      ring2.current.rotation.y -= delta * 0.4 * speedMult;
      ring2.current.rotation.z += delta * 0.6 * speedMult;
    }
    // expanding pulse ring while she is actually speaking (real amplitude)
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
      {/* lights: the GLB uses a textured standard material and needs them */}
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
      <mesh ref={ring1} rotation={[Math.PI / 2, 0, 0]} position={[0, -1.35, 0]}>
        <torusGeometry args={[2.2, 0.02, 12, 64]} />
        <meshBasicMaterial color="#0088ff" transparent opacity={0.5} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh ref={ring2} rotation={[Math.PI / 2.2, 0.2, 0]} position={[0, -1.5, 0]}>
        <torusGeometry args={[2.6, 0.015, 12, 64]} />
        <meshBasicMaterial color="#22d3ee" transparent opacity={0.35} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
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
  const paceRef = useRef(125);    // what the demand loop asked for (33 active / 125 idle)
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
    // auto-degrade: sustained slow frames WHILE ACTIVE -> hand back to the CSS orb.
    // Idle frames arrive at an intentional 125ms cadence (paceRef 125) and must never
    // count as slow — that false positive silently killed the 3D core after ~11s idle.
    if (paceRef.current === 33 && delta > 0.05 && delta < 2) {
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

    // expanding pulse ring while she is actually speaking (real amplitude)
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

export default function Core3D({ stateRef, ampRef, onDegrade }) {
  const [dead, setDead] = useState(false);
  // Avatar-first: her GLB head is the persistent hologram. If the model can't
  // load/prepare we fall back to the orb scene (same canvas), and the orb's
  // degrade path still falls back to the CSS orb beyond that.
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
        ? <AvatarScene stateRef={stateRef} ampRef={ampRef} onFail={() => setAvatarOk(false)} onDegrade={(why) => { setDead(true); onDegrade && onDegrade(why); }} />
        : <CoreScene stateRef={stateRef} ampRef={ampRef} onDegrade={(why) => { setDead(true); onDegrade && onDegrade(why); }} />}
    </Canvas>
  );
}
