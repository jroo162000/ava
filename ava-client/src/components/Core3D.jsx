import React, { useRef, useMemo, useEffect, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

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
// ─────────────────────────────────────────────────────────────────────────────

const STATE_COLORS = {
  idle: ['#8b5cf6', '#22d3ee'],
  thinking: ['#a78bfa', '#8b5cf6'],
  speaking: ['#22d3ee', '#e0f2fe'],
  working: ['#fb923c', '#f59e0b'],
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

function CoreScene({ stateRef, ampRef, onDegrade }) {
  const { invalidate } = useThree();
  const groupRef = useRef();
  const ring1 = useRef();
  const ring2 = useRef();
  const pulseMesh = useRef();
  const pulseMat = useRef();
  const bobRef = useRef();
  const intensity = useRef(0);
  const slowFrames = useRef(0);
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

  // Self-managed demand loop: ~30fps while active, ~8fps idle (perf budget).
  useEffect(() => {
    let alive = true;
    let t;
    const tick = () => {
      if (!alive) return;
      invalidate();
      const s = stateRef.current;
      const active = s === 'speaking' || s === 'working' || s === 'thinking' || (ampRef.current | 0) > 60;
      t = setTimeout(tick, active ? 33 : 125);
    };
    tick();
    return () => { alive = false; clearTimeout(t); };
  }, [invalidate, stateRef, ampRef]);

  useFrame((st, delta) => {
    // auto-degrade: sustained slow frames -> hand back to the CSS orb
    if (delta > 0.05 && delta < 2) {
      slowFrames.current += 1;
      if (slowFrames.current > 90) { onDegrade && onDegrade('slow frames'); return; }
    } else if (delta <= 0.05) {
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
      <CoreScene stateRef={stateRef} ampRef={ampRef} onDegrade={(why) => { setDead(true); onDegrade && onDegrade(why); }} />
    </Canvas>
  );
}
