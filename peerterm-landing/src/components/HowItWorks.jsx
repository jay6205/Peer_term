import { useEffect, useRef } from 'react';
import anime from 'animejs/lib/anime.es';
import useScrollReveal from '../hooks/useScrollReveal';
import '../styles/HowItWorks.css';

const STEPS = [
  {
    num: '01',
    title: 'Host Runs One Command',
    desc: 'Run npx peer-term in your terminal. PeerTerm spawns a PTY session and generates a 6-digit code. No config, no sudo.',
    code: '$ npx peer-term',
  },
  {
    num: '02',
    title: 'Share the Code',
    desc: "Send the 6-digit code to your teammate over any channel — Slack, Discord, text, email. That's it.",
    code: 'Code: 847291',
  },
  {
    num: '03',
    title: 'Viewer Connects Instantly',
    desc: "Your teammate opens peerterm.dhananjaybalekar.in, enters the code, and they're in — full terminal access, end-to-end encrypted.",
    code: '✔ Connected (P2P)',
  },
];

export default function HowItWorks() {
  const titleRef = useScrollReveal();
  const stepsRef = useRef(null);

  useEffect(() => {
    const container = stepsRef.current;
    if (!container) return;
    const cards = container.querySelectorAll('.step-card');
    cards.forEach((c) => {
      c.style.opacity = '0';
      c.style.transform = 'translateY(40px)';
    });

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          anime({
            targets: cards,
            opacity: [0, 1],
            translateY: [40, 0],
            delay: anime.stagger(200),
            duration: 800,
            easing: 'easeOutExpo',
          });
          anime({
            targets: container.querySelectorAll('.step-connector'),
            scaleX: [0, 1],
            delay: anime.stagger(200, { start: 400 }),
            duration: 600,
            easing: 'easeOutExpo',
          });
          observer.unobserve(container);
        }
      },
      { threshold: 0.15 }
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <section id="how-it-works" className="hiw-section">
      <div className="section-inner">
        <div ref={titleRef}>
          <h2 className="section-title">How It Works</h2>
          <p className="section-subtitle">Three steps. Under 10 seconds. No accounts.</p>
        </div>
        <div ref={stepsRef} className="steps-row">
          {STEPS.map((s, i) => (
            <div key={i} className="step-wrapper">
              <div className="step-card">
                <div className="step-num">{s.num}</div>
                <h3>{s.title}</h3>
                <p>{s.desc}</p>
                <div className="step-code">
                  <code>{s.code}</code>
                </div>
              </div>
              {i < STEPS.length - 1 && <div className="step-connector" />}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
