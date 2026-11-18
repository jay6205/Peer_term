import { useEffect, useRef, useState } from 'react';
import {
  animate,
  createAnimatable,
  createScope,
  createSpring,
  onScroll,
  scrambleText,
  stagger,
  utils,
} from 'animejs';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import '../styles/CTA.css';

const COLS = 14;
const ROWS = 5;
const TOTAL_DOTS = COLS * ROWS;

export default function CTA() {
  const sectionRef = useRef(null);
  const gridRef = useRef(null);
  const magneticRef = useRef(null);
  const copyValRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const [ripples, setRipples] = useState(0);

  // Scroll-triggered entrance + magnetic CTA button
  useEffect(() => {
    const scope = createScope({ root: sectionRef }).add(() => {
      animate('.cta-reveal', {
        opacity: [0, 1],
        y: [28, 0],
        delay: stagger(80),
        duration: 750,
        ease: 'outExpo',
        autoplay: onScroll({
          target: sectionRef.current,
          enter: 'bottom-=12% top',
        }),
      });
    });

    const btn = magneticRef.current;
    let mag;
    const onMove = (e) => {
      if (!btn || !mag) return;
      const r = btn.getBoundingClientRect();
      mag.x(utils.clamp((e.clientX - (r.left + r.width / 2)) * 0.26, -12, 12));
      mag.y(utils.clamp((e.clientY - (r.top + r.height / 2)) * 0.26, -8, 8));
    };
    const onLeave = () => {
      mag?.x(0);
      mag?.y(0);
    };

    if (btn) {
      mag = createAnimatable(btn, {
        x: 260,
        y: 260,
        ease: 'out(3)',
      });
      btn.addEventListener('mousemove', onMove);
      btn.addEventListener('mouseleave', onLeave);
    }

    return () => {
      mag?.revert();
      btn?.removeEventListener('mousemove', onMove);
      btn?.removeEventListener('mouseleave', onLeave);
      scope.revert();
    };
  }, []);

  // Interactive 2D Anime.js Stagger Ripple Grid
  const triggerRipple = (originIndex) => {
    const grid = gridRef.current;
    if (!grid) return;
    setRipples((r) => r + 1);

    const dots = grid.querySelectorAll('.mesh-dot');
    animate(dots, {
      scale: [
        { to: 1.75, duration: 180, ease: 'outQuad' },
        { to: 1, duration: 540, ease: createSpring({ stiffness: 200, damping: 14 }) },
      ],
      backgroundColor: [
        { to: '#34d399', duration: 160 },
        { to: '#27303d', duration: 600 },
      ],
      delay: stagger(42, { grid: [COLS, ROWS], from: originIndex }),
    });
  };

  const handleCopy = () => {
    navigator.clipboard?.writeText('npx peer-term');
    setCopied(true);
    triggerRipple(Math.floor(TOTAL_DOTS / 2));

    if (copyValRef.current) {
      animate(copyValRef.current, {
        textContent: scrambleText({
          text: 'COPIED: npx peer-term',
          chars: '0-9A-Za-z-_ ',
          revealRate: 65,
          settleDuration: 200,
        }),
      });
    }

    setTimeout(() => {
      setCopied(false);
      if (copyValRef.current) {
        animate(copyValRef.current, {
          textContent: scrambleText({
            text: 'npx peer-term',
            chars: 'a-z-',
            revealRate: 60,
            settleDuration: 150,
          }),
        });
      }
    }, 2000);
  };

  return (
    <section ref={sectionRef} className="section-frame cta-section">
      <div className="container">
        <div className="cta-box panel-tech cta-reveal">
          <div className="cta-copy">
            <div className="eyebrow">READY TO CONNECT</div>
            <h2 className="section-heading">Start a session in one command.</h2>
            <p className="section-lead">
              Open source, zero signups, end-to-end encrypted. Click any node in the P2P mesh on
              the right to send a live stagger pulse.
            </p>

            <div className="cta-buttons">
              <a
                ref={magneticRef}
                href="https://peerterm.dhananjaybalekar.in/connect/"
                className="btn-signal"
              >
                <span>Open PeerTerm Viewer</span>
                <ArrowUpRight size={15} />
              </a>

              <button type="button" className="cmd-chip" onClick={handleCopy}>
                <span className="cmd-prompt">$</span>
                <span ref={copyValRef} className="cmd-val">
                  npx peer-term
                </span>
                <span className="cmd-icon">
                  {copied ? <Check size={14} className="text-signal" /> : <Copy size={14} />}
                </span>
              </button>
            </div>
          </div>

          <div className="mesh-panel">
            <div className="mesh-header mono">
              <span>INTERACTIVE P2P NODE MESH — CLICK ANY NODE</span>
              <span className="text-signal">PULSES: {String(ripples).padStart(2, '0')}</span>
            </div>
            <div ref={gridRef} className="mesh-grid">
              {Array.from({ length: TOTAL_DOTS }).map((_, i) => (
                <button
                  key={i}
                  type="button"
                  className="mesh-dot-btn"
                  aria-label={`Trigger node ripple ${i + 1}`}
                  onClick={() => triggerRipple(i)}
                >
                  <span className="mesh-dot" />
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
