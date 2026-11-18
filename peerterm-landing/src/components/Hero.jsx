import { useEffect, useRef, useState } from 'react';
import anime from 'animejs/lib/anime.es';
import TerminalDemo from './TerminalDemo';
import '../styles/Hero.css';

export default function Hero() {
  const titleRef = useRef(null);
  const subRef = useRef(null);
  const ctaRef = useRef(null);
  const badgesRef = useRef(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const tl = anime.timeline({ easing: 'easeOutExpo' });
    tl.add({ targets: titleRef.current, opacity: [0, 1], translateY: [50, 0], duration: 1000 })
      .add({ targets: subRef.current, opacity: [0, 1], translateY: [30, 0], duration: 800 }, '-=600')
      .add({
        targets: ctaRef.current?.children,
        opacity: [0, 1],
        translateY: [20, 0],
        delay: anime.stagger(100),
        duration: 600,
      }, '-=500')
      .add({
        targets: badgesRef.current?.children,
        opacity: [0, 1],
        scale: [0.8, 1],
        delay: anime.stagger(80),
        duration: 500,
      }, '-=400');
  }, []);

  const handleCopy = () => {
    navigator.clipboard.writeText('npx peer-term');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="hero">
      <div className="hero-bg-grid" />
      <div className="hero-glow hero-glow-1" />
      <div className="hero-glow hero-glow-2" />
      <div className="hero-content">
        <div className="hero-text">
          <h1 ref={titleRef} style={{ opacity: 0 }}>
            Share Your Terminal
            <br />
            <span className="hero-gradient">In 3 Seconds</span>
          </h1>
          <p ref={subRef} className="hero-sub" style={{ opacity: 0 }}>
            Peer-to-peer, end-to-end encrypted terminal sharing.
            No signups, no port forwarding, no client install.
            Just run one command and share the code.
          </p>
          <div ref={ctaRef} className="hero-ctas">
            <a href="https://peerterm.dhananjaybalekar.in" className="btn-primary">
              Open PeerTerm
              <span className="btn-arrow">→</span>
            </a>
            <div className="btn-command">
              <code>$ npx peer-term</code>
              <button className="btn-copy" onClick={handleCopy}>
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>
          <div ref={badgesRef} className="hero-badges">
            <span className="badge">🔒 E2E Encrypted</span>
            <span className="badge">⚡ Zero Install</span>
            <span className="badge">🌐 Open Source</span>
            <span className="badge">🛡️ No Signup</span>
          </div>
        </div>
        <div className="hero-visual">
          <TerminalDemo />
        </div>
      </div>
    </section>
  );
}
