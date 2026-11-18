import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  animate,
  createDraggable,
  createLayout,
  createScope,
  createSpring,
  onScroll,
  scrambleText,
  stagger,
} from 'animejs';
import {
  Cpu,
  Eye,
  FileArchive,
  FolderInput,
  Globe,
  GripHorizontal,
  Lock,
  Maximize2,
  Minimize2,
  Shuffle,
  Terminal,
  UploadCloud,
} from 'lucide-react';
import { trackLandingEvent, useSectionTracking } from '../utils/analytics';
import '../styles/CapabilitiesDeck.css';

const INITIAL_MODULES = [
  {
    id: 'e2ee',
    cat: 'security',
    code: 'MOD-01',
    title: 'Client-Side AES-256-GCM',
    metric: 'ZERO KNOWLEDGE',
    icon: Lock,
    summary: 'Keys are generated in your browser Web Crypto API via ephemeral ECDH P-256. Never leaves endpoints.',
    detail:
      'Every frame uses a unique 12-byte IV with authenticated encryption. Even if the relay server is subpoenaed or compromised, captured packets remain indistinguishable from random noise.',
    cliFlag: 'Enabled by default (cannot be disabled)',
  },
  {
    id: 'webrtc',
    cat: 'network',
    code: 'MOD-02',
    title: 'Direct WebRTC DataChannels',
    metric: '<10MS LAN RTT',
    icon: Globe,
    summary: 'Automatic ICE/STUN NAT traversal with zero-drop failover to encrypted WSS over port 443.',
    detail:
      'On local networks or routable peers, packets skip the relay completely for near-native responsiveness. Under symmetric corporate NATs, PeerTerm fails over seamlessly without restarting your PTY.',
    cliFlag: 'npx peer-term --relay wss://custom.internal',
  },
  {
    id: 'zero-install',
    cat: 'controls',
    code: 'MOD-03',
    title: 'Zero Viewer Installation',
    metric: 'ANY BROWSER',
    icon: Terminal,
    summary: 'No SSH client, no public keys, no accounts. Viewers open a URL on desktop, iPad, or phone.',
    detail:
      'Built on xterm.js with full 256-color ANSI support, dynamic resize fitting, floating copy toolbar, and dedicated mobile key controls (Tab, font scale, virtual keyboard trigger).',
    cliFlag: 'peerterm.dhananjaybalekar.in/connect/?code=847291',
  },
  {
    id: 'readonly',
    cat: 'controls',
    code: 'MOD-04',
    title: 'Live Permission Toggling',
    metric: 'ON-THE-FLY RW/RO',
    icon: Eye,
    summary: 'Switch active viewers between Interactive and View-Only instantly without dropping sessions.',
    detail:
      'Hand control to a teammate while debugging a crash, then flip back to Read-Only the moment you inspect sensitive config files—enforced directly at the host PTY input gate.',
    cliFlag: 'Host control: r <session-code>',
  },
  {
    id: 'userspace',
    cat: 'security',
    code: 'MOD-05',
    title: 'Strict User-Space PTY',
    metric: 'NO SUDO / ROOT',
    icon: Cpu,
    summary: 'Runs strictly inside your current shell permissions across macOS, Linux, and Windows.',
    detail:
      'No kernel modules, no background daemons, no open inbound firewall ports. Closing the host CLI terminates the PTY and destroys all ephemeral session keys immediately.',
    cliFlag: 'npx peer-term (macOS / Linux / Win)',
  },
  {
    id: 'uploads',
    cat: 'network',
    code: 'MOD-06',
    title: '100MB Encrypted File Drop',
    metric: 'CHUNKED E2EE',
    icon: UploadCloud,
    summary: 'Drag files straight into the viewer to stream AES-GCM encrypted chunks to the host.',
    detail:
      'Files are sliced into encrypted binary chunks over the active DataChannel with live progress tracking and saved straight into the host uploads directory without cloud staging.',
    cliFlag: 'Saved to: ./peerterm-uploads/',
  },
];

const CATEGORIES = [
  { id: 'all', label: 'ALL MODULES' },
  { id: 'security', label: 'SECURITY' },
  { id: 'network', label: 'NETWORK' },
  { id: 'controls', label: 'CONTROLS' },
];

export default function CapabilitiesDeck() {
  const sectionRef = useRef(null);
  const gridRef = useRef(null);
  const layoutRef = useRef(null);

  // Draggable file upload simulation refs
  const dropArenaRef = useRef(null);
  const fileChipRef = useRef(null);
  const dropZoneRef = useRef(null);
  const fileDragRef = useRef(null);
  const hashRef = useRef(null);

  const [modules, setModules] = useState(INITIAL_MODULES);
  const [filter, setFilter] = useState('all');
  const [expandedId, setExpandedId] = useState('e2ee');
  const [uploadState, setUploadState] = useState({ status: 'idle', progress: 0 });
  const [overTarget, setOverTarget] = useState(false);

  useSectionTracking(sectionRef, 'capabilities_deck');

  // Scroll-triggered reveal + createLayout initialization
  useEffect(() => {
    const scope = createScope({ root: sectionRef }).add(() => {
      animate('.deck-reveal', {
        opacity: [0, 1],
        y: [28, 0],
        delay: stagger(70),
        duration: 720,
        ease: 'outExpo',
        autoplay: onScroll({
          target: sectionRef.current,
          enter: 'bottom-=10% top',
        }),
      });
    });

    if (gridRef.current) {
      layoutRef.current = createLayout(gridRef.current, {
        duration: 520,
        ease: 'outExpo',
        enterFrom: { opacity: 0, transform: 'scale(0.92)' },
        leaveTo: { opacity: 0, transform: 'scale(0.9)' },
      });
    }

    return () => {
      layoutRef.current?.revert();
      scope.revert();
    };
  }, []);

  // FLIP-animated state updates via Anime.js createLayout
  const updateDeckLayout = (updater) => {
    if (!layoutRef.current) {
      updater();
      return;
    }
    layoutRef.current.update(() => {
      flushSync(updater);
    });
  };

  const handleFilter = (nextCat) => {
    trackLandingEvent('deck_filter', { category: nextCat });
    updateDeckLayout(() => {
      setFilter(nextCat);
      if (nextCat !== 'all') {
        const first = modules.find((m) => m.cat === nextCat);
        if (first) setExpandedId(first.id);
      }
    });
  };

  const handleShuffle = () => {
    trackLandingEvent('deck_shuffle');
    updateDeckLayout(() => {
      setModules((prev) => {
        const copy = [...prev];
        for (let i = copy.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
      });
    });
  };

  const toggleExpand = (id) => {
    if (expandedId !== id) {
      trackLandingEvent('deck_expand', { module_id: id });
    }
    updateDeckLayout(() => {
      setExpandedId((curr) => (curr === id ? null : id));
    });
  };

  // Interactive Draggable File Chip -> Drop onto Host Uploads Target
  useEffect(() => {
    const arena = dropArenaRef.current;
    const chip = fileChipRef.current;
    const zone = dropZoneRef.current;
    if (!arena || !chip || !zone) return;

    const isOverlapping = () => {
      const cr = chip.getBoundingClientRect();
      const zr = zone.getBoundingClientRect();
      return !(
        cr.right < zr.left + 12 ||
        cr.left > zr.right - 12 ||
        cr.bottom < zr.top + 8 ||
        cr.top > zr.bottom - 8
      );
    };

    const runEncryptedTransfer = () => {
      const proxy = { pct: 0 };
      setUploadState({ status: 'uploading', progress: 0 });

      animate(proxy, {
        pct: [0, 100],
        duration: 1350,
        ease: 'inOutQuart',
        onUpdate: () => {
          setUploadState({ status: 'uploading', progress: Math.round(proxy.pct) });
        },
        onComplete: () => {
          setUploadState({ status: 'done', progress: 100 });
          trackLandingEvent('file_drop_complete');
          if (hashRef.current) {
            animate(hashRef.current, {
              textContent: scrambleText({
                text: 'SHA256: 9F2E...A41C · SAVED TO ~/uploads/',
                chars: '0-9A-F',
                revealRate: 55,
                settleDuration: 220,
              }),
            });
          }
          animate(zone, {
            scale: [1, 1.03, 1],
            duration: 420,
            ease: createSpring({ stiffness: 280, damping: 14 }),
          });
        },
      });
    };

    const drag = createDraggable(chip, {
      container: arena,
      containerPadding: 10,
      releaseEase: createSpring({ stiffness: 210, damping: 17 }),
      cursor: { onHover: 'grab', onGrab: 'grabbing' },
      onDrag: () => {
        setOverTarget(isOverlapping());
      },
      onRelease: () => {
        const hit = isOverlapping();
        setOverTarget(false);
        if (hit) {
          runEncryptedTransfer();
        }
        // Spring chip neatly back to origin after release
        animate(chip, {
          x: 0,
          y: 0,
          duration: 600,
          ease: createSpring({ stiffness: 180, damping: 16 }),
          onComplete: () => drag.reset(),
        });
      },
    });

    fileDragRef.current = drag;
    return () => drag.revert();
  }, []);

  const visibleModules =
    filter === 'all' ? modules : modules.filter((m) => m.cat === filter);

  return (
    <section ref={sectionRef} id="capabilities" className="section-frame">
      <div className="container">
        <div className="section-header deck-reveal">
          <div>
            <div className="eyebrow">03 // MODULAR CAPABILITIES · AUTOLAYOUT</div>
            <h2 className="section-heading">Built like a CLI tool, not a bloatware suite.</h2>
          </div>

          <div className="deck-toolbar">
            <div className="deck-filters" role="tablist" aria-label="Filter modules">
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === c.id}
                  className={`filter-pill ${filter === c.id ? 'is-active' : ''}`}
                  onClick={() => handleFilter(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <button type="button" className="btn-ghost shuffle-btn" onClick={handleShuffle}>
              <Shuffle size={14} />
              <span>Shuffle Grid</span>
            </button>
          </div>
        </div>

        {/* Anime.js createLayout FLIP Grid */}
        <div ref={gridRef} className="deck-grid">
          {visibleModules.map((mod) => {
            const Icon = mod.icon;
            const isExpanded = expandedId === mod.id;
            return (
              <article
                key={mod.id}
                data-layout-id={mod.id}
                className={`deck-card panel-tech ${isExpanded ? 'is-expanded' : ''}`}
                onClick={() => toggleExpand(mod.id)}
              >
                <div className="deck-card-head">
                  <div className="deck-id-group">
                    <span className="deck-icon-box">
                      <Icon size={16} />
                    </span>
                    <span className="deck-code">{mod.code}</span>
                    <span className="deck-metric">{mod.metric}</span>
                  </div>
                  <button
                    type="button"
                    className="deck-expand-btn"
                    aria-label={isExpanded ? 'Collapse module' : 'Expand module'}
                  >
                    {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                  </button>
                </div>

                <h3 className="deck-title">{mod.title}</h3>
                <p className="deck-summary">{mod.summary}</p>

                {isExpanded && (
                  <div className="deck-expanded-body">
                    <p className="deck-detail">{mod.detail}</p>
                    <div className="deck-cli-box">
                      <span className="text-signal">$</span> {mod.cliFlag}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>

        {/* Interactive Draggable Encrypted File Drop Sandbox */}
        <div className="drop-sandbox panel-tech deck-reveal">
          <div className="drop-sandbox-head">
            <span className="mono">TRY ENCRYPTED DRAG-AND-DROP TRANSFER</span>
            <span className="mono text-signal">MAX 100 MB · 64KB AES-GCM CHUNKS</span>
          </div>

          <div ref={dropArenaRef} className="drop-arena">
            <div ref={fileChipRef} className="draggable-file-chip">
              <GripHorizontal size={14} className="chip-grip" />
              <FileArchive size={18} className="text-signal" />
              <div className="file-chip-meta">
                <strong>prod-bundle.tar.gz</strong>
                <span>42.4 MB · Drag me →</span>
              </div>
            </div>

            <div className="drop-arrow-hint mono">DRAG CHIP INTO HOST TARGET →</div>

            <div
              ref={dropZoneRef}
              className={`host-drop-target ${overTarget ? 'is-over' : ''} ${
                uploadState.status === 'done' ? 'is-done' : ''
              }`}
            >
              <FolderInput size={20} className={overTarget || uploadState.status === 'done' ? 'text-signal' : ''} />
              <div className="drop-target-copy">
                <strong>
                  {overTarget
                    ? 'Release to Encrypt & Stream'
                    : uploadState.status === 'uploading'
                      ? `Encrypting chunks... ${uploadState.progress}%`
                      : uploadState.status === 'done'
                        ? 'Transfer Verified (42.4 MB)'
                        : 'HOST ~/peerterm-uploads/'}
                </strong>
                <span ref={hashRef} className="mono">
                  {uploadState.status === 'idle'
                    ? 'Awaiting encrypted DataChannel payload'
                    : uploadState.status === 'uploading'
                      ? 'AES-256-GCM · Streaming binary frames'
                      : 'SHA256: 9F2E...A41C · SAVED TO ~/uploads/'}
                </span>
              </div>

              <div className="drop-progress-bar">
                <div
                  className="drop-progress-fill"
                  style={{ width: `${uploadState.progress}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
