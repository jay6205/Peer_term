import { useCallback, useEffect, useRef, useState } from 'react';
import {
  animate,
  createDraggable,
  createScope,
  createSpring,
  createTimeline,
  scrambleText,
  splitText,
  stagger,
} from 'animejs';
import {
  ArrowUpRight,
  Check,
  Copy,
  Eye,
  GripHorizontal,
  Lock,
  RotateCcw,
  Terminal,
  Unlock,
  Wifi,
} from 'lucide-react';
import '../styles/Hero.css';

const COMMAND_PRESETS = [
  {
    cmd: 'git status -sb',
    out: [
      '## main...origin/main',
      ' M server/relay.ts',
      ' M client/crypto/aes-gcm.ts',
    ],
  },
  {
    cmd: 'kubectl get pods -n prod',
    out: [
      'peerterm-relay-7f9c   1/1   Running   0   14d',
      'turn-edge-eu-west     1/1   Running   0   14d',
    ],
  },
  {
    cmd: 'ls -lh ./uploads',
    out: [
      '-rw-r--r--  42.4M  prod-dump.sql.gz  [AES-256-GCM]',
      '-rw-r--r--   1.8M  nginx.conf        [AES-256-GCM]',
    ],
  },
];

const INITIAL_HISTORY = [
  { kind: 'cmd', text: 'npx peer-term' },
  { kind: 'ok', text: '⬡ PeerTerm v1.0.0 · PTY attached (/bin/zsh)' },
  { kind: 'ok', text: '✓ ECDH P-256 + AES-256-GCM session keys ready' },
  { kind: 'code', text: 'SESSION CODE: 847 291' },
  { kind: 'ok', text: '✓ Peer joined via WebRTC DataChannel (direct)' },
];

export default function Hero({ booted }) {
  const heroRef = useRef(null);
  const stageRef = useRef(null);
  const hostWinRef = useRef(null);
  const viewerWinRef = useRef(null);
  const cablePathRef = useRef(null);
  const packetDotRef = useRef(null);
  const copyTextRef = useRef(null);
  const badgeTextRef = useRef(null);
  const viewerCipherRef = useRef(null);
  const hostDragRef = useRef(null);
  const viewerDragRef = useRef(null);

  const [history, setHistory] = useState(INITIAL_HISTORY);
  const [readOnly, setReadOnly] = useState(false);
  const [copied, setCopied] = useState(false);
  const [latency, setLatency] = useState(4.2);
  const [activeZ, setActiveZ] = useState({ host: 2, viewer: 3 });
  const [packetCount, setPacketCount] = useState(14);
  const [cableMid, setCableMid] = useState({ x: 320, y: 190 });
  const [draggingNode, setDraggingNode] = useState(null);

  const updateCable = useCallback(() => {
    const stage = stageRef.current;
    const host = hostWinRef.current;
    const viewer = viewerWinRef.current;
    const pathEl = cablePathRef.current;
    if (!stage || !host || !viewer || !pathEl) return;

    const sr = stage.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const vr = viewer.getBoundingClientRect();

    const x1 = hr.left - sr.left + hr.width * 0.85;
    const y1 = hr.top - sr.top + hr.height * 0.48;
    const x2 = vr.left - sr.left + vr.width * 0.15;
    const y2 = vr.top - sr.top + vr.height * 0.48;

    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.hypot(dx, dy);
    const curve = Math.max(60, Math.abs(dx) * 0.45);

    const d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + curve).toFixed(1)} ${y1.toFixed(1)}, ${(x2 - curve).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    pathEl.setAttribute('d', d);

    setCableMid({
      x: (x1 + x2) / 2,
      y: (y1 + y2) / 2,
    });

    const computedLatency = Number((2.4 + dist * 0.012).toFixed(1));
    setLatency(computedLatency);
  }, []);

  // Pulse an encrypted packet along the live SVG tunnel cable
  const firePacket = useCallback(() => {
    const pathEl = cablePathRef.current;
    const dotEl = packetDotRef.current;
    if (!pathEl || !dotEl) return;

    const totalLen = pathEl.getTotalLength();
    if (!totalLen || Number.isNaN(totalLen)) return;

    const proxy = { t: 0 };
    dotEl.style.opacity = '1';

    animate(proxy, {
      t: [0, 1],
      duration: 460,
      ease: 'inOutCubic',
      onUpdate: () => {
        const pt = pathEl.getPointAtLength(proxy.t * totalLen);
        dotEl.setAttribute('cx', pt.x.toFixed(1));
        dotEl.setAttribute('cy', pt.y.toFixed(1));
      },
      onComplete: () => {
        dotEl.style.opacity = '0';
      },
    });
  }, []);

  // Boot-synced Hero Entrance with official Anime.js splitText + scrambleText + createTimeline
  useEffect(() => {
    if (!booted) return;

    const scope = createScope({ root: heroRef }).add(() => {
      const headline = heroRef.current?.querySelector('.hero-headline');
      const split = headline
        ? splitText(headline, {
            words: { wrap: 'clip' },
            chars: true,
          })
        : null;

      const tl = createTimeline({ defaults: { ease: 'outExpo' } });

      if (badgeTextRef.current) {
        tl.add(badgeTextRef.current, {
          opacity: [0, 1],
          textContent: scrambleText({
            text: 'WEBRTC P2P · AES-256-GCM · ZERO VIEWER INSTALL',
            chars: '0-9A-F·_',
            revealRate: 65,
            settleDuration: 200,
            cursor: '█',
          }),
        }, 0);
      }

      if (split?.chars?.length) {
        tl.add(split.chars, {
          y: ['115%', '0%'],
          opacity: [0, 1],
          delay: stagger(16),
          duration: 680,
          ease: 'outExpo',
        }, 80);
      }

      tl.add('.hero-fade', {
        opacity: [0, 1],
        y: [22, 0],
        delay: stagger(75),
        duration: 700,
      }, 280)
        .add('.workbench-shell', {
          opacity: [0, 1],
          y: [30, 0],
          scale: [0.97, 1],
          duration: 850,
          ease: createSpring({ stiffness: 160, damping: 20 }),
        }, 360)
        .add('.draggable-win', {
          opacity: [0, 1],
          y: [20, 0],
          delay: stagger(130),
          duration: 720,
          ease: createSpring({ stiffness: 190, damping: 18 }),
          onComplete: () => {
            updateCable();
            firePacket();
          },
        }, 520);
    });

    return () => scope.revert();
  }, [booted, updateCable, firePacket]);

  // Setup Anime.js createDraggable on BOTH Host and Viewer terminal windows
  useEffect(() => {
    const stage = stageRef.current;
    const hostEl = hostWinRef.current;
    const viewerEl = viewerWinRef.current;
    if (!stage || !hostEl || !viewerEl) return;

    const hostDrag = createDraggable(hostEl, {
      trigger: '.host-drag-handle',
      container: stage,
      containerPadding: 14,
      containerFriction: 0.72,
      releaseEase: createSpring({ stiffness: 180, damping: 16 }),
      cursor: { onHover: 'grab', onGrab: 'grabbing' },
      onGrab: () => {
        setActiveZ({ host: 10, viewer: 5 });
        setDraggingNode('host');
      },
      onDrag: () => updateCable(),
      onUpdate: () => updateCable(),
      onRelease: () => setDraggingNode(null),
    });

    const viewerDrag = createDraggable(viewerEl, {
      trigger: '.viewer-drag-handle',
      container: stage,
      containerPadding: 14,
      containerFriction: 0.72,
      releaseEase: createSpring({ stiffness: 180, damping: 16 }),
      cursor: { onHover: 'grab', onGrab: 'grabbing' },
      onGrab: () => {
        setActiveZ({ host: 5, viewer: 10 });
        setDraggingNode('viewer');
      },
      onDrag: () => updateCable(),
      onUpdate: () => updateCable(),
      onRelease: () => setDraggingNode(null),
    });

    hostDragRef.current = hostDrag;
    viewerDragRef.current = viewerDrag;

    updateCable();
    window.addEventListener('resize', updateCable);

    const pulseInterval = setInterval(() => {
      firePacket();
    }, 2800);

    return () => {
      clearInterval(pulseInterval);
      window.removeEventListener('resize', updateCable);
      hostDrag.revert();
      viewerDrag.revert();
    };
  }, [updateCable, firePacket]);

  const runPreset = (preset) => {
    setHistory((prev) => {
      const next = [
        ...prev,
        { kind: 'cmd', text: preset.cmd },
        ...preset.out.map((line) => ({ kind: 'out', text: line })),
      ];
      return next.slice(-11);
    });
    setPacketCount((c) => c + 3);
    firePacket();

    // Flash scrambleText decryption indicator in viewer header
    if (viewerCipherRef.current) {
      animate(viewerCipherRef.current, {
        textContent: scrambleText({
          text: `DECRYPTED · ${preset.cmd.split(' ')[0].toUpperCase()}`,
          chars: '0-9A-F',
          revealRate: 50,
          settleDuration: 220,
        }),
      });
    }

    // Subtle spring nudge on viewer window to show incoming packet
    if (viewerWinRef.current) {
      animate(viewerWinRef.current, {
        scale: [1, 1.015, 1],
        duration: 380,
        ease: createSpring({ stiffness: 260, damping: 14 }),
      });
    }
  };

  const resetNodes = () => {
    hostDragRef.current?.animateInView?.();
    if (hostWinRef.current) {
      animate(hostWinRef.current, {
        x: 0,
        y: 0,
        duration: 650,
        ease: createSpring({ stiffness: 170, damping: 16 }),
        onUpdate: updateCable,
      });
    }
    if (viewerWinRef.current) {
      animate(viewerWinRef.current, {
        x: 0,
        y: 0,
        duration: 650,
        ease: createSpring({ stiffness: 170, damping: 16 }),
        onUpdate: updateCable,
      });
    }
    hostDragRef.current?.reset();
    viewerDragRef.current?.reset();
    setTimeout(updateCable, 60);
  };

  const handleCopyCommand = () => {
    navigator.clipboard?.writeText('npx peer-term');
    setCopied(true);
    if (copyTextRef.current) {
      animate(copyTextRef.current, {
        textContent: scrambleText({
          text: 'COPIED TO CLIPBOARD',
          chars: 'A-Z0-9_',
          revealRate: 70,
          settleDuration: 180,
        }),
      });
    }
    setTimeout(() => {
      setCopied(false);
      if (copyTextRef.current) {
        animate(copyTextRef.current, {
          textContent: scrambleText({
            text: 'npx peer-term',
            chars: 'a-z-',
            revealRate: 60,
            settleDuration: 150,
          }),
        });
      }
    }, 1800);
  };

  return (
    <section ref={heroRef} id="workbench" className={`hero-section ${!booted ? 'hero-section--preboot' : ''}`}>
      <div className="container">
        {/* Top editorial + action bar */}
        <div className="hero-top">
          <div className="hero-copy">
            <div className="hero-status-pill">
              <span className="pulse-dot" />
              <span ref={badgeTextRef} className="mono">
                WEBRTC P2P · AES-256-GCM · ZERO VIEWER INSTALL
              </span>
            </div>

            <h1 className="hero-headline">
              Share your live terminal across any browser. Zero trust required.
            </h1>

            <p className="hero-description hero-fade">
              Run one command to generate a 6-digit code. Your teammate opens a URL and gets an
              end-to-end encrypted WebRTC terminal—no SSH keys, no port forwarding, no relay
              visibility.
            </p>

            <div className="hero-actions hero-fade">
              <a href="https://peerterm.dhananjaybalekar.in/connect/" className="btn-signal">
                <span>Open Web Viewer</span>
                <ArrowUpRight size={15} />
              </a>

              <button type="button" className="cmd-chip" onClick={handleCopyCommand}>
                <span className="cmd-prompt">$</span>
                <span ref={copyTextRef} className="cmd-val">
                  npx peer-term
                </span>
                <span className="cmd-icon">
                  {copied ? <Check size={14} className="text-signal" /> : <Copy size={14} />}
                </span>
              </button>
            </div>
          </div>

          <div className="hero-specs hero-fade">
            <div className="spec-row">
              <span className="spec-k">KEY EXCHANGE</span>
              <span className="spec-v">ECDH P-256 (Ephemeral)</span>
            </div>
            <div className="spec-row">
              <span className="spec-k">CIPHER SUITE</span>
              <span className="spec-v">AES-256-GCM · 12B IV</span>
            </div>
            <div className="spec-row">
              <span className="spec-k">TRANSPORT</span>
              <span className="spec-v">WebRTC DataChannel → WSS :443</span>
            </div>
            <div className="spec-row">
              <span className="spec-k">HOST RUNTIME</span>
              <span className="spec-v">macOS · Linux · Windows (User-space)</span>
            </div>
          </div>
        </div>

        {/* Interactive Draggable P2P Spatial Workbench */}
        <div className="workbench-shell panel-tech">
          <div className="workbench-bar">
            <div className="wb-bar-left">
              <span className="wb-tag">
                <GripHorizontal size={14} />
                INTERACTIVE WORKBENCH — DRAG EITHER TERMINAL NODE
              </span>
            </div>

            <div className="wb-bar-controls">
              {COMMAND_PRESETS.map((preset) => (
                <button
                  key={preset.cmd}
                  type="button"
                  className="wb-cmd-btn"
                  onClick={() => runPreset(preset)}
                >
                  $ {preset.cmd.split(' ')[0]}
                </button>
              ))}
              <button
                type="button"
                className={`wb-cmd-btn ${readOnly ? 'wb-cmd-btn--amber' : ''}`}
                onClick={() => {
                  setReadOnly((r) => !r);
                  firePacket();
                }}
              >
                {readOnly ? <Eye size={13} /> : <Unlock size={13} />}
                <span>{readOnly ? 'View-Only' : 'Interactive'}</span>
              </button>
              <button type="button" className="wb-cmd-btn" onClick={resetNodes} title="Reset node positions">
                <RotateCcw size={13} />
              </button>
            </div>
          </div>

          <div ref={stageRef} className="workbench-stage">
            {/* Live SVG tunnel wire between the two draggable windows */}
            <svg className="tunnel-svg" aria-hidden="true">
              <path ref={cablePathRef} className="tunnel-path" d="M 320 190 C 420 190, 440 190, 560 190" />
              <circle ref={packetDotRef} className="tunnel-packet" r="5" cx="0" cy="0" style={{ opacity: 0 }} />
            </svg>

            {/* Floating dynamic latency badge pinned to cable midpoint */}
            <div
              className="tunnel-telemetry-pill"
              style={{
                left: `${cableMid.x}px`,
                top: `${cableMid.y}px`,
              }}
            >
              <Wifi size={12} className="text-signal" />
              <span>{latency} ms</span>
              <span className="pill-sep">·</span>
              <span>{packetCount} pkts</span>
            </div>

            {/* DRAGGABLE WINDOW 1: HOST CLI */}
            <div
              ref={hostWinRef}
              className={`draggable-win win-host ${draggingNode === 'host' ? 'is-grabbed' : ''}`}
              style={{ zIndex: activeZ.host }}
            >
              <div className="win-header host-drag-handle">
                <div className="win-title">
                  <Terminal size={13} className="text-signal" />
                  <span>HOST CLI · macOS / zsh</span>
                </div>
                <div className="win-meta">
                  <span className="win-drag-hint">DRAG</span>
                  <GripHorizontal size={14} />
                </div>
              </div>
              <div className="win-body">
                {history.map((item, i) => (
                  <div key={i} className={`term-row term-row--${item.kind}`}>
                    {item.kind === 'cmd' && <span className="term-ps1">➜ ~/app </span>}
                    <span>{item.text}</span>
                  </div>
                ))}
                <div className="term-row">
                  <span className="term-ps1">➜ ~/app </span>
                  <span className="term-cursor" />
                </div>
              </div>
            </div>

            {/* DRAGGABLE WINDOW 2: BROWSER VIEWER */}
            <div
              ref={viewerWinRef}
              className={`draggable-win win-viewer ${draggingNode === 'viewer' ? 'is-grabbed' : ''}`}
              style={{ zIndex: activeZ.viewer }}
            >
              <div className="win-header viewer-drag-handle">
                <div className="win-title">
                  <Lock size={13} className="text-signal" />
                  <span>VIEWER · Chrome (Zero Install)</span>
                </div>
                <div className="win-meta">
                  <span ref={viewerCipherRef} className="viewer-cipher">
                    AES-256-GCM
                  </span>
                  <GripHorizontal size={14} />
                </div>
              </div>
              <div className="viewer-subbar">
                <span>https://peerterm.dhananjaybalekar.in/connect/?code=847291</span>
                <span className={`mode-pill ${readOnly ? 'mode-pill--ro' : ''}`}>
                  {readOnly ? 'VIEW ONLY' : 'RW LIVE'}
                </span>
              </div>
              <div className="win-body">
                {history.map((item, i) => (
                  <div key={i} className={`term-row term-row--${item.kind}`}>
                    {item.kind === 'cmd' && <span className="term-ps1">➜ ~/app </span>}
                    <span>{item.text}</span>
                  </div>
                ))}
                <div className="term-row term-row--dim">
                  {readOnly
                    ? '— input locked by host (read-only mode) —'
                    : '— mirrored live over WebRTC DataChannel —'}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
