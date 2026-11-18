import useStaggerReveal from '../hooks/useStaggerReveal';
import useScrollReveal from '../hooks/useScrollReveal';
import '../styles/Features.css';

const FEATURES = [
  {
    icon: '⚡',
    title: 'Zero Install for Viewers',
    desc: 'Viewers connect directly in any modern browser — desktop, tablet, or mobile. No SSH client, no keys, no setup.',
  },
  {
    icon: '🔒',
    title: 'End-to-End Encrypted',
    desc: 'AES-256-GCM encryption with ECDH P-256 key exchange. The relay server never sees your data — only opaque binary blobs.',
  },
  {
    icon: '🌐',
    title: 'Works Behind Firewalls',
    desc: 'WebRTC for direct P2P when possible. Automatic WSS fallback over port 443 for corporate firewalls and VPNs.',
  },
  {
    icon: '📁',
    title: 'Encrypted File Transfer',
    desc: 'Drag and drop files up to 100MB directly into the host terminal. Every byte is encrypted before transmission.',
  },
  {
    icon: '👁️',
    title: 'Live Read-Only Toggle',
    desc: 'Switch any connected viewer between interactive and read-only mode on the fly without dropping the connection.',
  },
  {
    icon: '🖥️',
    title: 'Cross-Platform',
    desc: 'The host CLI works on macOS, Linux, and Windows. Viewers need nothing but a web browser.',
  },
];

export default function Features() {
  const titleRef = useScrollReveal();
  const gridRef = useStaggerReveal('.feature-card', { stagger: 100 });

  return (
    <section id="features" className="features-section">
      <div className="section-inner">
        <div ref={titleRef}>
          <h2 className="section-title">Everything You Need</h2>
          <p className="section-subtitle">
            PeerTerm is built from the ground up for secure, frictionless terminal sharing.
          </p>
        </div>
        <div ref={gridRef} className="features-grid">
          {FEATURES.map((f, i) => (
            <div key={i} className="feature-card">
              <div className="feature-icon">{f.icon}</div>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
