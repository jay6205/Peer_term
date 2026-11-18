import { useEffect, useRef, useState } from 'react';
import anime from 'animejs/lib/anime.es';
import '../styles/TerminalDemo.css';

const HOST_LINES = [
  { prompt: '~', text: 'npx peer-term', delay: 600 },
  { text: '', delay: 300 },
  { text: '  ⬡ PeerTerm v1.0.0', delay: 100, cls: 'green' },
  { text: '  ✔ Terminal session started', delay: 200, cls: 'green' },
  { text: '  ✔ E2E encryption: AES-256-GCM + ECDH P-256', delay: 200, cls: 'green' },
  { text: '', delay: 100 },
  { text: '  Share this code with your viewer:', delay: 200 },
  { text: '  ┌───────────────────┐', delay: 100, cls: 'cyan' },
  { text: '  │     8 4 7 2 9 1     │', delay: 100, cls: 'code-highlight' },
  { text: '  └───────────────────┘', delay: 100, cls: 'cyan' },
  { text: '', delay: 100 },
  { text: '  ⏳ Waiting for viewer to connect...', delay: 300, cls: 'dim' },
  { text: '  ✔ Viewer connected (WebRTC P2P)', delay: 800, cls: 'green' },
];

export default function TerminalDemo() {
  const [lines, setLines] = useState([]);
  const containerRef = useRef(null);
  const hasRun = useRef(false);

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;

    let cumDelay = 1200;
    const timeouts = [];
    HOST_LINES.forEach((line) => {
      cumDelay += line.delay;
      timeouts.push(
        setTimeout(() => {
          setLines((prev) => [...prev, line]);
        }, cumDelay)
      );
    });

    return () => timeouts.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
    const allLines = containerRef.current?.querySelectorAll('.term-line');
    if (allLines?.length) {
      const last = allLines[allLines.length - 1];
      anime({
        targets: last,
        opacity: [0, 1],
        translateX: [-10, 0],
        duration: 400,
        easing: 'easeOutExpo',
      });
    }
  }, [lines]);

  return (
    <div className="terminal-window">
      <div className="terminal-titlebar">
        <div className="terminal-dots">
          <span className="dot red" />
          <span className="dot yellow" />
          <span className="dot green" />
        </div>
        <span className="terminal-title">peer-term — bash</span>
        <div className="terminal-dots-spacer" />
      </div>
      <div className="terminal-body" ref={containerRef}>
        {lines.map((l, i) => (
          <div key={i} className="term-line" style={{ opacity: 0 }}>
            {l.prompt && <span className="term-prompt">{l.prompt} $ </span>}
            <span className={l.cls || ''}>{l.text}</span>
            {i === lines.length - 1 && <span className="term-cursor">▋</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
