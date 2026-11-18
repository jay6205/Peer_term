import { useEffect, useRef, useState } from 'react';
import { animate, createAnimatable, createScope, onScroll, stagger, utils } from 'animejs';
import { ArrowUpRight, Menu, X } from 'lucide-react';
import '../styles/Navbar.css';

const NAV_ITEMS = [
  { id: 'workbench', label: '01 Workbench' },
  { id: 'encryption-lab', label: '02 Tunnel Lab' },
  { id: 'capabilities', label: '03 Modules' },
  { id: 'pipeline', label: '04 Protocol' },
  { id: 'comparison', label: '05 Compare' },
  { id: 'faq', label: '06 FAQ' },
];

export default function Navbar({ booted }) {
  const navRef = useRef(null);
  const progressRef = useRef(null);
  const magneticBtnRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrollPct, setScrollPct] = useState(0);

  // Entrance animation synced with boot completion
  useEffect(() => {
    if (!booted) return;
    const scope = createScope({ root: navRef }).add(() => {
      animate('.nav-stagger', {
        opacity: [0, 1],
        y: [-14, 0],
        delay: stagger(45),
        duration: 600,
        ease: 'outExpo',
      });
    });
    return () => scope.revert();
  }, [booted]);

  // Scroll-synced telemetry bar using Anime.js onScroll + createAnimatable magnetic button
  useEffect(() => {
    const scrollAnim = animate(progressRef.current, {
      scaleX: [0, 1],
      ease: 'linear',
      autoplay: onScroll({
        target: document.documentElement,
        enter: 'top top',
        leave: 'bottom bottom',
        sync: 0.35,
        onUpdate: (self) => {
          setScrollPct(Math.round(self.progress * 100));
        },
      }),
    });

    const btn = magneticBtnRef.current;
    let mag;
    const handleMove = (e) => {
      if (!btn || !mag) return;
      const r = btn.getBoundingClientRect();
      const dx = utils.clamp((e.clientX - (r.left + r.width / 2)) * 0.28, -10, 10);
      const dy = utils.clamp((e.clientY - (r.top + r.height / 2)) * 0.28, -6, 6);
      mag.x(dx);
      mag.y(dy);
    };
    const handleLeave = () => {
      if (!mag) return;
      mag.x(0);
      mag.y(0);
    };

    if (btn) {
      mag = createAnimatable(btn, {
        x: 240,
        y: 240,
        ease: 'out(3)',
      });
      btn.addEventListener('mousemove', handleMove);
      btn.addEventListener('mouseleave', handleLeave);
    }

    const onWinScroll = () => setScrolled(window.scrollY > 24);
    window.addEventListener('scroll', onWinScroll, { passive: true });

    return () => {
      scrollAnim.revert();
      mag?.revert();
      btn?.removeEventListener('mousemove', handleMove);
      btn?.removeEventListener('mouseleave', handleLeave);
      window.removeEventListener('scroll', onWinScroll);
    };
  }, []);

  const scrollTo = (id) => {
    setMenuOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <header ref={navRef} className={`navbar ${scrolled ? 'navbar--scrolled' : ''}`}>
      <div className="nav-progress-rail">
        <div ref={progressRef} className="nav-progress-fill" />
      </div>

      <div className="nav-inner">
        <button
          className="nav-brand nav-stagger"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          <svg viewBox="0 0 28 28" width="22" height="22" fill="none" aria-hidden="true">
            <polygon points="14,2 25,8 25,20 14,26 3,20 3,8" stroke="var(--signal)" strokeWidth="1.8" />
            <polyline points="9,11 13,14 9,17" stroke="var(--ink)" strokeWidth="2" strokeLinecap="square" />
            <line x1="15" y1="17" x2="19" y2="17" stroke="var(--signal)" strokeWidth="2" strokeLinecap="square" />
          </svg>
          <span className="nav-wordmark">PeerTerm</span>
          <span className="nav-ver">v1.0</span>
        </button>

        <nav className={`nav-links ${menuOpen ? 'nav-links--open' : ''}`} aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className="nav-link nav-stagger"
              onClick={() => scrollTo(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="nav-right nav-stagger">
          <span className="nav-telemetry" aria-hidden="true">
            SCROLL {scrollPct.toString().padStart(3, '0')}%
          </span>
          <a
            href="https://github.com/jay6205/Peer_term"
            target="_blank"
            rel="noopener noreferrer"
            className="nav-gh"
          >
            GitHub
          </a>
          <a
            ref={magneticBtnRef}
            href="https://peerterm.dhananjaybalekar.in/connect/"
            className="nav-launch"
          >
            <span>Launch</span>
            <ArrowUpRight size={14} />
          </a>
          <button
            className="nav-mobile-toggle"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Toggle navigation"
          >
            {menuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </div>
    </header>
  );
}
