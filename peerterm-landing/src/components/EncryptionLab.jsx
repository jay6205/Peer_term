import { useEffect, useRef, useState } from 'react';
import {
  animate,
  createDraggable,
  createScope,
  createSpring,
  onScroll,
  scrambleText,
  stagger,
  svg,
} from 'animejs';
import { Eye, EyeOff, GripVertical, ShieldCheck, Terminal, Radio, Server } from 'lucide-react';
import { trackLandingEvent, useSectionTracking } from '../utils/analytics';
import '../styles/EncryptionLab.css';

const MODES = [
  {
    id: 'p2p',
    index: 0,
    label: '01 · LAN / Direct P2P',
    transport: 'WebRTC DataChannel (ICE Direct)',
    latency: '3.9 ms',
    relayRole: 'BYPASSED AFTER SIGNALING',
    port: 'UDP Ephemeral',
    note: 'Direct browser-to-host socket on local or routable networks. Sub-10ms keystroke echo with zero relay hops.',
  },
  {
    id: 'stun',
    index: 1,
    label: '02 · NAT Traversal',
    transport: 'WebRTC + STUN Hole Punching',
    latency: '17.4 ms',
    relayRole: 'SIGNALING ONLY (ZERO DATA)',
    port: 'UDP 3478 / STUN',
    note: 'Discovers public reflexive addresses automatically across home routers and cloud VPCs without port forwarding.',
  },
  {
    id: 'wss',
    index: 2,
    label: '03 · Corporate Firewall',
    transport: 'E2EE WebSocket Fallback (TLS)',
    latency: '34.2 ms',
    relayRole: 'BLIND CIPHERTEXT FORWARDER',
    port: 'TCP 443 (WSS)',
    note: 'When symmetric NAT or strict proxies block UDP, PeerTerm fails over cleanly to port 443. The relay still only sees opaque AES-GCM frames.',
  },
];

function toFakeHex(str) {
  let out = '';
  for (let i = 0; i < Math.max(24, str.length); i++) {
    const code = (str.charCodeAt(i % str.length) * 31 + i * 17) & 0xff;
    out += code.toString(16).toUpperCase().padStart(2, '0') + ' ';
  }
  return out.trim().slice(0, 56);
}

export default function EncryptionLab() {
  const sectionRef = useRef(null);
  const trackRef = useRef(null);
  const knobRef = useRef(null);
  const draggableRef = useRef(null);
  const wireReadoutRef = useRef(null);
  const latencyValRef = useRef(null);
  const packetAnimRef = useRef(null);

  const [modeIndex, setModeIndex] = useState(0);
  const modeIndexRef = useRef(0);
  modeIndexRef.current = modeIndex;
  const [perspective, setPerspective] = useState('relay'); // 'host' | 'relay' | 'viewer'
  const [payload, setPayload] = useState('export PROD_TOKEN=pt_live_98f2a1c0');

  useSectionTracking(sectionRef, 'encryption_lab');

  const activeMode = MODES[modeIndex];

  // Scroll-triggered entrance for the whole Encryption Lab
  useEffect(() => {
    const scope = createScope({ root: sectionRef }).add(() => {
      animate('.lab-reveal', {
        opacity: [0, 1],
        y: [28, 0],
        delay: stagger(90),
        duration: 750,
        ease: 'outExpo',
        autoplay: onScroll({
          target: sectionRef.current,
          enter: 'bottom-=10% top',
        }),
      });
    });

    return () => scope.revert();
  }, []);

  // Draggable 3-stop physical mode slider using Anime.js createDraggable + snap + spring
  useEffect(() => {
    const track = trackRef.current;
    const knob = knobRef.current;
    if (!track || !knob) return;

    const getStops = () => {
      const usable = Math.max(0, track.clientWidth - knob.offsetWidth - 12);
      return [0, usable / 2, usable];
    };

    const drag = createDraggable(knob, {
      container: track,
      containerPadding: [6, 6, 6, 6],
      y: false,
      x: {
        snap: () => getStops(),
      },
      releaseEase: createSpring({ stiffness: 260, damping: 20 }),
      cursor: { onHover: 'grab', onGrab: 'grabbing' },
      onDrag: (self) => {
        const stops = getStops();
        const max = stops[2] || 1;
        const pct = self.x / max;
        const idx = pct < 0.33 ? 0 : pct < 0.67 ? 1 : 2;
        setModeIndex(idx);
      },
      onSnap: (self) => {
        const stops = getStops();
        let closest = 0;
        let best = Infinity;
        stops.forEach((s, i) => {
          const d = Math.abs(self.x - s);
          if (d < best) {
            best = d;
            closest = i;
          }
        });
        setModeIndex(closest);
        trackLandingEvent('lab_mode_change', { mode: MODES[closest].id, method: 'drag' });
      },
    });

    draggableRef.current = drag;

    const onResize = () => {
      const stops = getStops();
      drag.refresh();
      animate(knob, {
        x: stops[modeIndexRef.current],
        duration: 200,
        ease: 'outQuad',
      });
    };

    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      drag.revert();
    };
  }, []);

  // Click any mode stop to smoothly slide the draggable handle there
  const selectMode = (idx) => {
    setModeIndex(idx);
    trackLandingEvent('lab_mode_change', { mode: MODES[idx].id, method: 'click' });
    const track = trackRef.current;
    const knob = knobRef.current;
    if (!track || !knob) return;
    const usable = Math.max(0, track.clientWidth - knob.offsetWidth - 12);
    const targetX = idx === 0 ? 0 : idx === 1 ? usable / 2 : usable;

    animate(knob, {
      x: targetX,
      duration: 520,
      ease: createSpring({ stiffness: 230, damping: 18 }),
      onComplete: () => {
        draggableRef.current?.setX(targetX, true);
      },
    });
  };

  // Redraw SVG route & animate packet along motionPath whenever network mode changes
  useEffect(() => {
    const scope = createScope({ root: sectionRef }).add(() => {
      const activeSelector =
        modeIndex === 2 ? '.route-relay' : '.route-direct';
      const drawable = svg.createDrawable(activeSelector);

      animate(drawable, {
        draw: ['0 0', '0 1'],
        duration: 620,
        ease: 'inOutCubic',
      });

      const motionPath = svg.createMotionPath(activeSelector);
      packetAnimRef.current = animate('.topo-packet', {
        ...motionPath,
        duration: modeIndex === 0 ? 1300 : modeIndex === 1 ? 1800 : 2400,
        ease: 'linear',
        loop: true,
      });

      if (latencyValRef.current) {
        animate(latencyValRef.current, {
          textContent: scrambleText({
            text: activeMode.latency,
            chars: '0-9.',
            revealRate: 50,
            settleDuration: 200,
          }),
        });
      }
    });

    return () => {
      packetAnimRef.current?.revert?.();
      scope.revert();
    };
  }, [modeIndex, activeMode.latency]);

  // Scramble/Unscramble the live Wire Inspector readout whenever perspective or payload changes
  useEffect(() => {
    const el = wireReadoutRef.current;
    if (!el) return;

    const targetText =
      perspective === 'relay'
        ? `0x ${toFakeHex(payload)}`
        : `$ ${payload || 'whoami'}`;

    const anim = animate(el, {
      textContent: scrambleText({
        text: targetText,
        chars: perspective === 'relay' ? '0-9A-F ' : 'a-zA-Z0-9_=.-',
        revealRate: 65,
        settleDuration: 240,
        cursor: '█',
      }),
    });

    return () => anim.revert();
  }, [perspective, payload]);

  return (
    <section ref={sectionRef} id="encryption-lab" className="section-frame section-frame--alt">
      <div className="container">
        <div className="section-header lab-reveal">
          <div>
            <div className="eyebrow">02 // INTERACTIVE TUNNEL LAB</div>
            <h2 className="section-heading">Drag the network rail. Inspect the wire.</h2>
          </div>
          <p className="section-lead">
            Simulate how PeerTerm adapts from local WebRTC to strict corporate firewalls—and see
            why even a compromised relay can never read a single keystroke.
          </p>
        </div>

        <div className="lab-grid">
          {/* LEFT: Draggable Mode Rail + Live SVG Topology */}
          <div className="panel-tech lab-panel lab-reveal">
            <div className="lab-panel-head">
              <span className="mono lab-panel-title">NETWORK TOPOLOGY SIMULATOR</span>
              <span className="lab-latency-chip">
                RTT <strong ref={latencyValRef}>{activeMode.latency}</strong>
              </span>
            </div>

            {/* Draggable 3-Stop Physical Switch */}
            <div className="rail-controls">
              <div className="rail-labels">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`rail-stop-btn ${modeIndex === m.index ? 'is-active' : ''}`}
                    onClick={() => selectMode(m.index)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              <div ref={trackRef} className="draggable-rail-track">
                <div className="rail-tick" style={{ left: '16.6%' }} />
                <div className="rail-tick" style={{ left: '50%' }} />
                <div className="rail-tick" style={{ left: '83.3%' }} />
                <div ref={knobRef} className="draggable-rail-knob">
                  <GripVertical size={14} />
                  <span>DRAG MODE</span>
                </div>
              </div>
            </div>

            {/* Live SVG Topology Diagram */}
            <div className="topo-canvas">
              <svg viewBox="0 0 600 220" className="topo-svg" aria-label="PeerTerm network routing diagram">
                {/* Direct P2P Path */}
                <path
                  className={`topo-base-path ${modeIndex !== 2 ? 'is-dim' : ''}`}
                  d="M 88 145 C 210 145, 390 145, 512 145"
                />
                <path
                  className={`route-direct topo-active-path ${modeIndex !== 2 ? 'is-visible' : 'is-hidden'}`}
                  d="M 88 145 C 210 145, 390 145, 512 145"
                />

                {/* Relay WSS Fallback Path */}
                <path
                  className="topo-base-path"
                  d="M 88 145 C 145 55, 225 46, 300 46 C 375 46, 455 55, 512 145"
                />
                <path
                  className={`route-relay topo-active-path topo-active-path--amber ${modeIndex === 2 ? 'is-visible' : 'is-hidden'}`}
                  d="M 88 145 C 145 55, 225 46, 300 46 C 375 46, 455 55, 512 145"
                />

                {/* Firewall Wall (visible in mode 2) */}
                <g className={`topo-firewall ${modeIndex === 2 ? 'is-active' : ''}`}>
                  <line x1="300" y1="114" x2="300" y2="176" stroke="var(--danger)" strokeWidth="2.5" strokeDasharray="4 4" />
                  <text x="300" y="198" textAnchor="middle" fill="var(--danger)" fontSize="10" fontFamily="JetBrains Mono">
                    UDP BLOCKED (FIREWALL)
                  </text>
                </g>

                {/* Animated Encrypted Packet traveling along motionPath */}
                <g className="topo-packet">
                  <rect x="-12" y="-7" width="24" height="14" rx="3" fill="var(--bg)" stroke={modeIndex === 2 ? 'var(--amber)' : 'var(--signal)'} strokeWidth="1.8" />
                  <text x="0" y="3" textAnchor="middle" fill={modeIndex === 2 ? 'var(--amber)' : 'var(--signal)'} fontSize="7.5" fontFamily="JetBrains Mono" fontWeight="700">
                    GCM
                  </text>
                </g>
              </svg>

              {/* Hardware Node Labels overlaid cleanly */}
              <div className="topo-node topo-node--host">
                <Terminal size={15} className="text-signal" />
                <span>HOST PTY</span>
              </div>

              <div className={`topo-node topo-node--relay ${modeIndex === 2 ? 'is-engaged' : ''}`}>
                <Server size={15} className={modeIndex === 2 ? 'text-amber' : ''} />
                <span>BLIND RELAY</span>
                <small>{modeIndex === 2 ? 'WSS :443' : 'STANDBY'}</small>
              </div>

              <div className="topo-node topo-node--viewer">
                <Radio size={15} className="text-signal" />
                <span>BROWSER</span>
              </div>
            </div>

            <div className="topo-summary">
              <div className="topo-meta-grid">
                <div>
                  <span className="meta-k">TRANSPORT</span>
                  <span className="meta-v">{activeMode.transport}</span>
                </div>
                <div>
                  <span className="meta-k">PORT</span>
                  <span className="meta-v">{activeMode.port}</span>
                </div>
                <div>
                  <span className="meta-k">RELAY VISIBILITY</span>
                  <span className="meta-v text-signal">{activeMode.relayRole}</span>
                </div>
              </div>
              <p className="topo-note">{activeMode.note}</p>
            </div>
          </div>

          {/* RIGHT: Interactive Live Wire Ciphertext Inspector */}
          <div className="panel-tech lab-panel lab-reveal">
            <div className="lab-panel-head">
              <span className="mono lab-panel-title">E2EE WIRE INSPECTOR</span>
              <span className="mono wire-badge">
                <ShieldCheck size={13} /> AES-256-GCM
              </span>
            </div>

            <div className="wire-input-block">
              <label htmlFor="wire-payload-input" className="wire-label">
                TYPE A SECRET OR COMMAND TO TRANSMIT
              </label>
              <div className="wire-input-wrap">
                <span className="wire-ps1">$</span>
                <input
                  id="wire-payload-input"
                  type="text"
                  value={payload}
                  onChange={(e) => setPayload(e.target.value)}
                  maxLength={52}
                  spellCheck={false}
                />
              </div>
            </div>

            <div className="perspective-bar">
              {[
                { id: 'host', label: 'Host Machine', icon: <Eye size={13} /> },
                { id: 'relay', label: 'Blind Relay Server', icon: <EyeOff size={13} /> },
                { id: 'viewer', label: 'Viewer Browser', icon: <Eye size={13} /> },
              ].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`persp-btn ${perspective === p.id ? 'is-active' : ''} ${
                    p.id === 'relay' ? 'persp-btn--relay' : ''
                  }`}
                  onClick={() => {
                    setPerspective(p.id);
                    trackLandingEvent('lab_perspective_change', { perspective: p.id });
                  }}
                >
                  {p.icon}
                  <span>{p.label}</span>
                </button>
              ))}
            </div>

            <div className={`wire-screen wire-screen--${perspective}`}>
              <div className="wire-screen-bar">
                <span>
                  {perspective === 'relay'
                    ? 'PACKET CAPTURE @ RELAY NODE (OPAQUE CIPHERTEXT)'
                    : perspective === 'host'
                      ? 'LOCAL PTY BUFFER (BEFORE ENCRYPTION)'
                      : 'BROWSER WEB CRYPTO API (AFTER DECRYPTION)'}
                </span>
                <span className="wire-iv">IV: 9f4a21c8e0b3</span>
              </div>
              <div ref={wireReadoutRef} className="wire-readout">
                0x 9F 4A C2 08 7E 1B
              </div>
            </div>

            <div className="crypto-breakdown">
              <div className="crypto-step">
                <span className="crypto-tag">1. ECDH P-256</span>
                <p>Ephemeral public keys are exchanged via Web Crypto API; shared secret is derived locally on both ends.</p>
              </div>
              <div className="crypto-step">
                <span className="crypto-tag">2. UNIQUE 12B IV</span>
                <p>Every keystroke and stdout chunk gets a fresh cryptographic nonce + 128-bit GCM auth tag against tampering.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
