import { useEffect, useRef, useState } from 'react';
import { animate, createScope, createSpring, onScroll, stagger } from 'animejs';
import { Plus } from 'lucide-react';
import '../styles/FAQ.css';

const FAQS = [
  {
    q: 'Can the relay server see my terminal output or passwords?',
    a: 'No. PeerTerm performs ephemeral ECDH P-256 key exchange via the browser Web Crypto API and encrypts every frame locally with AES-256-GCM and unique 12-byte IVs. The relay only ever forwards opaque binary blobs and never possesses decryption keys.',
  },
  {
    q: 'How does PeerTerm work behind strict corporate firewalls?',
    a: 'PeerTerm first negotiates a direct peer-to-peer WebRTC DataChannel via STUN. If symmetric NAT, VPNs, or enterprise firewalls block UDP, it automatically falls back to an end-to-end encrypted WebSocket relay over standard HTTPS/WSS (port 443).',
  },
  {
    q: 'Does PeerTerm require root or sudo privileges?',
    a: 'Never. Both the host CLI (npx peer-term) and the browser viewer operate strictly in user space inside your current shell permissions. No kernel drivers, no inbound open ports.',
  },
  {
    q: 'Can I self-host my own private relay server?',
    a: 'Yes. Pass --relay wss://your-relay.internal when invoking the host CLI to route signaling and fallback traffic through your own infrastructure.',
  },
  {
    q: 'How is PeerTerm different from tmate?',
    a: 'tmate requires viewers to have an SSH client configured and terminates SSH sessions at its relay servers. PeerTerm works in any browser with zero setup, enforces true client-side E2EE, uses direct WebRTC P2P when available, and adds 100MB encrypted file uploads plus live read-only toggling.',
  },
];

function FAQRow({ faq, idx, isOpen, onToggle }) {
  const bodyRef = useRef(null);
  const iconRef = useRef(null);

  useEffect(() => {
    const body = bodyRef.current;
    const icon = iconRef.current;
    if (!body || !icon) return;

    if (isOpen) {
      animate(body, {
        height: [0, body.scrollHeight],
        opacity: [0, 1],
        duration: 460,
        ease: createSpring({ stiffness: 200, damping: 22 }),
      });
      animate(icon, {
        rotate: 45,
        duration: 320,
        ease: createSpring({ stiffness: 260, damping: 18 }),
      });
    } else {
      animate(body, {
        height: 0,
        opacity: 0,
        duration: 280,
        ease: 'outExpo',
      });
      animate(icon, {
        rotate: 0,
        duration: 280,
        ease: 'outExpo',
      });
    }
  }, [isOpen]);

  return (
    <div className={`faq-row panel-tech faq-reveal ${isOpen ? 'is-open' : ''}`}>
      <button type="button" className="faq-trigger" onClick={onToggle} aria-expanded={isOpen}>
        <span className="faq-index mono">{String(idx + 1).padStart(2, '0')}</span>
        <span className="faq-question">{faq.q}</span>
        <span ref={iconRef} className="faq-icon">
          <Plus size={16} />
        </span>
      </button>
      <div ref={bodyRef} className="faq-body" style={{ height: 0, opacity: 0, overflow: 'hidden' }}>
        <p className="faq-answer">{faq.a}</p>
      </div>
    </div>
  );
}

export default function FAQ() {
  const sectionRef = useRef(null);
  const [openIdx, setOpenIdx] = useState(0);

  useEffect(() => {
    const scope = createScope({ root: sectionRef }).add(() => {
      animate('.faq-reveal', {
        opacity: [0, 1],
        y: [22, 0],
        delay: stagger(65),
        duration: 680,
        ease: 'outExpo',
        autoplay: onScroll({
          target: sectionRef.current,
          enter: 'bottom-=10% top',
        }),
      });
    });

    return () => scope.revert();
  }, []);

  return (
    <section ref={sectionRef} id="faq" className="section-frame section-frame--alt">
      <div className="container">
        <div className="section-header faq-reveal">
          <div>
            <div className="eyebrow">06 // TECHNICAL FAQ</div>
            <h2 className="section-heading">Security &amp; deployment questions.</h2>
          </div>
          <p className="section-lead">
            Straight answers on cryptography, firewall traversal, self-hosting, and permissions.
          </p>
        </div>

        <div className="faq-stack">
          {FAQS.map((faq, idx) => (
            <FAQRow
              key={idx}
              faq={faq}
              idx={idx}
              isOpen={openIdx === idx}
              onToggle={() => setOpenIdx(openIdx === idx ? -1 : idx)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
