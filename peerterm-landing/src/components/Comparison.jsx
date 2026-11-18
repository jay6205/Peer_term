import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { animate, createLayout, createScope, onScroll, stagger } from 'animejs';
import { Check, Minus, X } from 'lucide-react';
import { trackLandingEvent, useSectionTracking } from '../utils/analytics';
import '../styles/Comparison.css';

const COMP_ROWS = [
  { id: 'browser', cat: 'setup', feature: 'Browser-based viewer (zero install)', peerterm: true, tmate: false, ssh: false, liveshare: 'Extension' },
  { id: 'e2ee', cat: 'security', feature: 'True client-side E2EE (blind relay)', peerterm: true, tmate: false, ssh: true, liveshare: false },
  { id: 'p2p', cat: 'speed', feature: 'Direct P2P WebRTC (sub-10ms LAN)', peerterm: true, tmate: false, ssh: false, liveshare: false },
  { id: 'firewall', cat: 'speed', feature: 'Corporate firewall WSS :443 fallback', peerterm: true, tmate: 'SSH :22', ssh: 'Port fwd', liveshare: true },
  { id: 'uploads', cat: 'setup', feature: 'Encrypted drag-and-drop uploads (100MB)', peerterm: true, tmate: false, ssh: 'Via SCP', liveshare: false },
  { id: 'readonly', cat: 'security', feature: 'Live read-only permission toggle', peerterm: true, tmate: '2nd URL', ssh: false, liveshare: true },
  { id: 'nosudo', cat: 'security', feature: 'Runs strictly in user space (no sudo)', peerterm: true, tmate: true, ssh: true, liveshare: true },
  { id: 'cross', cat: 'setup', feature: 'Cross-platform host (macOS / Linux / Win)', peerterm: true, tmate: 'Unix only', ssh: true, liveshare: true },
];

const FILTERS = [
  { id: 'all', label: 'ALL METRICS' },
  { id: 'security', label: 'SECURITY' },
  { id: 'speed', label: 'NETWORK & SPEED' },
  { id: 'setup', label: 'ZERO-SETUP UX' },
];

function StatusCell({ val, highlight }) {
  if (val === true) {
    return (
      <span className={`cmp-badge cmp-badge--yes ${highlight ? 'is-primary' : ''}`}>
        <Check size={14} />
        <span>Yes</span>
      </span>
    );
  }
  if (val === false) {
    return (
      <span className="cmp-badge cmp-badge--no">
        <X size={13} />
        <span>No</span>
      </span>
    );
  }
  return (
    <span className="cmp-badge cmp-badge--partial">
      <Minus size={12} />
      <span>{val}</span>
    </span>
  );
}

export default function Comparison() {
  const sectionRef = useRef(null);
  const listRef = useRef(null);
  const layoutRef = useRef(null);
  const [cat, setCat] = useState('all');

  useSectionTracking(sectionRef, 'comparison_matrix');

  useEffect(() => {
    const scope = createScope({ root: sectionRef }).add(() => {
      animate('.cmp-reveal', {
        opacity: [0, 1],
        y: [24, 0],
        delay: stagger(70),
        duration: 700,
        ease: 'outExpo',
        autoplay: onScroll({
          target: sectionRef.current,
          enter: 'bottom-=10% top',
        }),
      });
    });

    if (listRef.current) {
      layoutRef.current = createLayout(listRef.current, {
        duration: 460,
        ease: 'outExpo',
        enterFrom: { opacity: 0, transform: 'translateY(14px)' },
        leaveTo: { opacity: 0, transform: 'translateY(-10px)' },
      });
    }

    return () => {
      layoutRef.current?.revert();
      scope.revert();
    };
  }, []);

  const handleCat = (next) => {
    trackLandingEvent('comparison_filter', { category: next });
    if (!layoutRef.current) {
      setCat(next);
      return;
    }
    layoutRef.current.update(() => {
      flushSync(() => setCat(next));
    });
  };

  const rows = cat === 'all' ? COMP_ROWS : COMP_ROWS.filter((r) => r.cat === cat);

  return (
    <section ref={sectionRef} id="comparison" className="section-frame">
      <div className="container">
        <div className="section-header cmp-reveal">
          <div>
            <div className="eyebrow">05 // FEATURE COMPARISON · AUTOLAYOUT</div>
            <h2 className="section-heading">Side-by-side feature breakdown.</h2>
          </div>

          <div className="deck-filters" role="tablist" aria-label="Filter comparison metrics">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={cat === f.id}
                className={`filter-pill ${cat === f.id ? 'is-active' : ''}`}
                onClick={() => handleCat(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="cmp-matrix panel-tech cmp-reveal">
          <div className="cmp-head">
            <div className="cmp-col-feature">CAPABILITY</div>
            <div className="cmp-col cmp-col--pt">PEERTERM</div>
            <div className="cmp-col">TMATE</div>
            <div className="cmp-col">SSH SHARE</div>
            <div className="cmp-col">LIVE SHARE</div>
          </div>

          <div ref={listRef} className="cmp-body">
            {rows.map((row) => (
              <div key={row.id} data-layout-id={row.id} className="cmp-row">
                <div className="cmp-col-feature">{row.feature}</div>
                <div className="cmp-col cmp-col--pt">
                  <StatusCell val={row.peerterm} highlight />
                </div>
                <div className="cmp-col">
                  <StatusCell val={row.tmate} />
                </div>
                <div className="cmp-col">
                  <StatusCell val={row.ssh} />
                </div>
                <div className="cmp-col">
                  <StatusCell val={row.liveshare} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
