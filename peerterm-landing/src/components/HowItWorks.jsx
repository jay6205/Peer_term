import { useEffect, useRef, useState } from 'react';
import {
  animate,
  createScope,
  createSpring,
  onScroll,
  scrambleText,
  stagger,
  svg,
} from 'animejs';
import { KeyRound, Radio, Terminal } from 'lucide-react';
import { trackLandingEvent, useSectionTracking } from '../utils/analytics';
import '../styles/HowItWorks.css';

const STAGES = [
  {
    step: '01',
    id: 'spawn',
    title: 'Spawn Local PTY',
    tag: 'HOST CLI · USER SPACE',
    icon: Terminal,
    summary: 'Run npx peer-term in your shell. A local pseudo-terminal starts with your existing permissions and prints a 6-digit session code.',
    frameHeader: 'STAGE 01 // SESSION REGISTRATION',
    frameLines: [
      '$ npx peer-term',
      '→ Spawning /bin/zsh PTY (cols: 120, rows: 34)',
      '→ Generating ephemeral ECDH P-256 keypair',
      '→ Session code issued: 847 291 (TTL: active while open)',
    ],
  },
  {
    step: '02',
    id: 'handshake',
    title: 'Zero-Trust ECDH Handshake',
    tag: 'WEB CRYPTO API · P-256',
    icon: KeyRound,
    summary: 'Your teammate enters the 6-digit code in any browser. Both ends exchange public keys and derive an identical AES-256-GCM key locally.',
    frameHeader: 'STAGE 02 // KEY AGREEMENT',
    frameLines: [
      '← Peer pubkey: 04:8a:f1:93:0c:e2:44:7b...9e',
      '→ Host pubkey: 04:2d:c9:71:aa:18:5f:03...1a',
      '✓ Shared secret derived via HKDF-SHA256',
      '✓ ICE candidates exchanged · Direct P2P path selected',
    ],
  },
  {
    step: '03',
    id: 'stream',
    title: 'Encrypted Bi-Directional Stream',
    tag: 'WEBRTC DATACHANNEL / WSS :443',
    icon: Radio,
    summary: 'Terminal stdout, keystrokes, resize events, and 100MB file transfers stream as authenticated AES-GCM frames. Toggle read-only anytime.',
    frameHeader: 'STAGE 03 // LIVE MULTIPLEXED CHANNEL',
    frameLines: [
      '⇄ Frame #0041 [STDOUT]  1.4 KB · IV 7e2a... · 3.8ms RTT',
      '⇄ Frame #0042 [STDIN]   16 B   · IV 91c4... · verified',
      '⇄ Frame #0043 [RESIZE]  142x40 · synced to host PTY',
      '✓ Host toggled [r 847291] → Viewer set to READ-ONLY',
    ],
  },
];

export default function HowItWorks() {
  const sectionRef = useRef(null);
  const frameTitleRef = useRef(null);
  const frameCardRef = useRef(null);
  const [activeIdx, setActiveIdx] = useState(0);

  useSectionTracking(sectionRef, 'protocol_pipeline');

  const stage = STAGES[activeIdx];

  // Scroll-synced SVG conduit draw + staggered stage reveal
  useEffect(() => {
    const scope = createScope({ root: sectionRef }).add(() => {
      const conduit = svg.createDrawable('.pipeline-conduit-active');

      animate(conduit, {
        draw: ['0 0', '0 1'],
        ease: 'linear',
        autoplay: onScroll({
          target: sectionRef.current,
          enter: 'bottom-=15% top',
          leave: 'center top',
          sync: 0.45,
        }),
      });

      animate('.pipe-reveal', {
        opacity: [0, 1],
        y: [26, 0],
        delay: stagger(95),
        duration: 720,
        ease: 'outExpo',
        autoplay: onScroll({
          target: sectionRef.current,
          enter: 'bottom-=10% top',
        }),
      });
    });

    return () => scope.revert();
  }, []);

  // Scramble header + spring pulse whenever stage switches
  useEffect(() => {
    if (frameTitleRef.current) {
      animate(frameTitleRef.current, {
        textContent: scrambleText({
          text: stage.frameHeader,
          chars: '0-9A-Z/_ ',
          revealRate: 65,
          settleDuration: 200,
        }),
      });
    }
    if (frameCardRef.current) {
      animate(frameCardRef.current.querySelectorAll('.frame-line'), {
        opacity: [0, 1],
        x: [-14, 0],
        delay: stagger(65),
        duration: 420,
        ease: createSpring({ stiffness: 220, damping: 20 }),
      });
    }
  }, [activeIdx, stage.frameHeader]);

  return (
    <section ref={sectionRef} id="pipeline" className="section-frame section-frame--alt">
      <div className="container">
        <div className="section-header pipe-reveal">
          <div>
            <div className="eyebrow">04 // PROTOCOL PIPELINE · SCROLL-SYNCED</div>
            <h2 className="section-heading">Three steps. Under ten seconds.</h2>
          </div>
          <p className="section-lead">
            Scroll to trace the handshake conduit or click any stage to inspect the live protocol
            frames exchanged between CLI and browser.
          </p>
        </div>

        {/* Scroll-synced SVG circuit line connecting the 3 stages */}
        <div className="conduit-wrap pipe-reveal" aria-hidden="true">
          <svg viewBox="0 0 1000 24" preserveAspectRatio="none" className="conduit-svg">
            <line x1="0" y1="12" x2="1000" y2="12" stroke="var(--line-strong)" strokeWidth="2" strokeDasharray="6 6" />
            <line
              className="pipeline-conduit-active"
              x1="0"
              y1="12"
              x2="1000"
              y2="12"
              stroke="var(--signal)"
              strokeWidth="2.5"
            />
          </svg>
        </div>

        <div className="stage-grid">
          {STAGES.map((s, idx) => {
            const Icon = s.icon;
            const isActive = idx === activeIdx;
            return (
              <button
                key={s.id}
                type="button"
                className={`stage-card panel-tech pipe-reveal ${isActive ? 'is-active' : ''}`}
                onClick={() => {
                  setActiveIdx(idx);
                  trackLandingEvent('pipeline_stage_click', { stage: s.id, step: s.step });
                }}
              >
                <div className="stage-top">
                  <span className="stage-num">{s.step}</span>
                  <span className="stage-tag">{s.tag}</span>
                  <Icon size={16} className={isActive ? 'text-signal' : 'stage-icon'} />
                </div>
                <h3>{s.title}</h3>
                <p>{s.summary}</p>
              </button>
            );
          })}
        </div>

        {/* Interactive Protocol Frame Readout */}
        <div ref={frameCardRef} className="protocol-frame panel-tech pipe-reveal">
          <div className="protocol-frame-bar">
            <span ref={frameTitleRef} className="mono text-signal">
              {stage.frameHeader}
            </span>
            <span className="mono frame-hint">CLICK ANY STAGE ABOVE TO INSPECT</span>
          </div>
          <div className="protocol-frame-body">
            {stage.frameLines.map((line, i) => (
              <div key={`${stage.id}-${i}`} className="frame-line">
                <span className="frame-idx">{String(i + 1).padStart(2, '0')}</span>
                <span>{line}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
