import { useState, useRef } from 'react';
import anime from 'animejs/lib/anime.es';
import useScrollReveal from '../hooks/useScrollReveal';
import '../styles/FAQ.css';

const FAQS = [
  {
    q: 'Can the relay server see my terminal output or passwords?',
    a: 'No. PeerTerm uses client-side End-to-End Encryption (E2EE) with AES-256-GCM and ECDH P-256 key exchange. Keys are negotiated directly between your browser and the host terminal via the Web Crypto API. The relay server acts strictly as a blind packet forwarder.',
  },
  {
    q: 'How do I run PeerTerm behind a corporate firewall?',
    a: 'PeerTerm first attempts a direct peer-to-peer WebRTC DataChannel connection using STUN. If that fails, it automatically falls back to an encrypted WebSocket relay over standard HTTPS/WSS (port 443), which works seamlessly through corporate proxies and firewalls.',
  },
  {
    q: 'Does PeerTerm require root or sudo privileges?',
    a: 'No. PeerTerm operates entirely in user space. Neither the host command (npx peer-term) nor the web viewer requires root, administrator, or sudo privileges.',
  },
  {
    q: 'How does PeerTerm compare to tmate?',
    a: "While tmate requires viewers to have SSH clients, PeerTerm works directly in the browser. PeerTerm also offers true E2E encryption (tmate's relay can read data), direct P2P WebRTC connections with sub-10ms latency, encrypted file uploads, and live read-only toggling.",
  },
  {
    q: 'Can I self-host the relay server?',
    a: 'Yes! PeerTerm supports self-hosting. Use the --relay <url> flag when starting the host to route sessions through your own private relay server. The relay only forwards opaque encrypted blobs.',
  },
  {
    q: 'What happens if the WebRTC connection drops?',
    a: 'PeerTerm automatically falls back to the encrypted WebSocket relay without losing the session. The viewer stays connected and the terminal stream continues seamlessly.',
  },
];

function FAQItem({ faq, isOpen, onToggle }) {
  const ansRef = useRef(null);

  const handleToggle = () => {
    const el = ansRef.current;
    if (!el) return;

    if (!isOpen) {
      onToggle();
      el.style.height = '0px';
      el.style.opacity = '0';
      requestAnimationFrame(() => {
        anime({
          targets: el,
          height: [0, el.scrollHeight],
          opacity: [0, 1],
          duration: 400,
          easing: 'easeOutExpo',
        });
      });
    } else {
      anime({
        targets: el,
        height: 0,
        opacity: 0,
        duration: 300,
        easing: 'easeInExpo',
        complete: onToggle,
      });
    }
  };

  return (
    <div className={`faq-item ${isOpen ? 'open' : ''}`}>
      <button className="faq-q" onClick={handleToggle}>
        <span>{faq.q}</span>
        <span className="faq-chevron">{isOpen ? '−' : '+'}</span>
      </button>
      <div
        ref={ansRef}
        className="faq-a"
        style={{ height: isOpen ? 'auto' : 0, opacity: isOpen ? 1 : 0, overflow: 'hidden' }}
      >
        <p>{faq.a}</p>
      </div>
    </div>
  );
}

export default function FAQ() {
  const [openIndex, setOpenIndex] = useState(null);
  const titleRef = useScrollReveal();

  return (
    <section id="faq" className="faq-section">
      <div className="section-inner">
        <div ref={titleRef}>
          <h2 className="section-title">Frequently Asked Questions</h2>
        </div>
        <div className="faq-list">
          {FAQS.map((faq, i) => (
            <FAQItem
              key={i}
              faq={faq}
              isOpen={openIndex === i}
              onToggle={() => setOpenIndex(openIndex === i ? null : i)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
