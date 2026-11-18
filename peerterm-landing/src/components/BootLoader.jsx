import { useEffect, useRef } from 'react';
import { createScope, createTimeline, svg, scrambleText } from 'animejs';
import { trackLandingEvent } from '../utils/analytics';
import '../styles/BootLoader.css';

export default function BootLoader({ onCurtainStart, onComplete }) {
  const rootRef = useRef(null);
  const doneRef = useRef(false);
  const onCurtainStartRef = useRef(onCurtainStart);
  const onCompleteRef = useRef(onComplete);
  onCurtainStartRef.current = onCurtainStart;
  onCompleteRef.current = onComplete;

  const handleSkip = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    trackLandingEvent('boot_skipped');
    onCompleteRef.current?.();
  };

  useEffect(() => {
    const scope = createScope({ root: rootRef }).add(() => {
      const hexPaths = svg.createDrawable('.boot-draw');

      const tl = createTimeline({
        defaults: { ease: 'outExpo' },
        onComplete: () => {
          if (doneRef.current) return;
          doneRef.current = true;
          onCompleteRef.current?.();
        },
      });

      tl.add(hexPaths, {
        draw: ['0 0', '0 1'],
        duration: 550,
        ease: 'inOutQuad',
      }, 0)
        .add('.boot-status', {
          textContent: scrambleText({
            text: 'ECDH P-256 // AES-256-GCM // READY',
            chars: '0-9A-F/._',
            revealRate: 55,
            settleDuration: 180,
            cursor: '█',
          }),
        }, 120)
        .add('.boot-progress-fill', {
          scaleX: [0, 1],
          duration: 720,
          ease: 'inOutQuart',
        }, 100)
        .add('.boot-percent', {
          innerHTML: [0, 100],
          modifier: (v) => `${Math.round(v).toString().padStart(3, '0')}%`,
          duration: 720,
          ease: 'inOutQuart',
        }, 100)
        .add('.boot-core', {
          opacity: [1, 0],
          y: [0, -18],
          duration: 260,
          ease: 'inQuad',
        }, 880)
        .call(() => onCurtainStartRef.current?.(), 940)
        .add('.boot-curtain-top', {
          y: ['0%', '-100%'],
          duration: 460,
          ease: 'inOutExpo',
        }, 940)
        .add('.boot-curtain-bottom', {
          y: ['0%', '100%'],
          duration: 460,
          ease: 'inOutExpo',
        }, 940);
    });

    return () => scope.revert();
  }, []);

  return (
    <div ref={rootRef} className="boot-overlay" onClick={handleSkip} role="status" aria-label="Initializing PeerTerm">
      <div className="boot-curtain boot-curtain-top" />
      <div className="boot-curtain boot-curtain-bottom" />
      <div className="boot-core">
        <svg className="boot-emblem" viewBox="0 0 80 80" width="64" height="64" fill="none">
          <polygon
            className="boot-draw"
            points="40,5 70,22 70,58 40,75 10,58 10,22"
            stroke="var(--signal)"
            strokeWidth="2"
          />
          <polyline
            className="boot-draw"
            points="27,32 37,40 27,48"
            stroke="var(--ink)"
            strokeWidth="2.5"
            strokeLinecap="square"
          />
          <line
            className="boot-draw"
            x1="41"
            y1="48"
            x2="54"
            y2="48"
            stroke="var(--signal)"
            strokeWidth="2.5"
            strokeLinecap="square"
          />
        </svg>

        <div className="boot-meta">
          <span className="boot-label">PEERTERM // SYS.INIT</span>
          <span className="boot-percent">000%</span>
        </div>

        <div className="boot-progress-track">
          <div className="boot-progress-fill" />
        </div>

        <div className="boot-status">NEGOTIATING KEYS...</div>
        <div className="boot-skip">click anywhere to skip</div>
      </div>
    </div>
  );
}
