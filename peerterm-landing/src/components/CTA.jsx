import { useEffect, useRef } from 'react';
import anime from 'animejs/lib/anime.es';
import useScrollReveal from '../hooks/useScrollReveal';
import '../styles/CTA.css';

export default function CTA() {
  const ref = useScrollReveal();
  const particlesRef = useRef(null);

  useEffect(() => {
    const container = particlesRef.current;
    if (!container) return;

    for (let i = 0; i < 20; i++) {
      const p = document.createElement('div');
      p.className = 'cta-particle';
      p.style.left = `${Math.random() * 100}%`;
      p.style.top = `${Math.random() * 100}%`;
      p.style.width = p.style.height = `${2 + Math.random() * 4}px`;
      container.appendChild(p);
    }

    anime({
      targets: container.querySelectorAll('.cta-particle'),
      translateY: () => anime.random(-40, 40),
      translateX: () => anime.random(-40, 40),
      opacity: [0, () => 0.2 + Math.random() * 0.3],
      scale: [0, 1],
      delay: anime.stagger(100),
      duration: 3000,
      easing: 'easeInOutSine',
      direction: 'alternate',
      loop: true,
    });
  }, []);

  return (
    <section className="cta-section">
      <div ref={particlesRef} className="cta-particles" />
      <div ref={ref} className="cta-content">
        <h2>Ready to Share Your Terminal?</h2>
        <p>Get started in one command. No signup, no config, no BS.</p>
        <div className="cta-actions">
          <div className="cta-command">
            <code>$ npx peer-term</code>
          </div>
          <a href="https://peerterm.dhananjaybalekar.in" className="btn-primary btn-lg">
            Open PeerTerm →
          </a>
        </div>
      </div>
    </section>
  );
}
