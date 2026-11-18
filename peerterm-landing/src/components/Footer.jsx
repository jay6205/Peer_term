import { useEffect, useRef } from 'react';
import { animate, createScope, onScroll, stagger } from 'animejs';
import { trackLandingEvent } from '../utils/analytics';
import '../styles/Footer.css';

export default function Footer() {
  const footerRef = useRef(null);

  useEffect(() => {
    const scope = createScope({ root: footerRef }).add(() => {
      animate('.ft-reveal', {
        opacity: [0, 1],
        y: [16, 0],
        delay: stagger(60),
        duration: 600,
        ease: 'outExpo',
        autoplay: onScroll({
          target: footerRef.current,
          enter: 'bottom top',
        }),
      });
    });

    return () => scope.revert();
  }, []);

  return (
    <footer ref={footerRef} className="footer">
      <div className="container footer-inner">
        <div className="footer-left ft-reveal">
          <span className="footer-mark mono text-signal">⬡ PEERTERM</span>
          <span className="footer-meta mono">MIT LICENSE · OPEN SOURCE · ZERO TELEMETRY ON RELAY</span>
        </div>

        <div className="footer-links ft-reveal">
          <a
            href="https://peerterm.dhananjaybalekar.in/connect/"
            onClick={() => trackLandingEvent('cta_click', { location: 'footer', destination: '/connect/' })}
          >
            Web App
          </a>
          <a
            href="https://github.com/jay6205/Peer_term"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackLandingEvent('outbound_click', { target: 'github', location: 'footer' })}
          >
            GitHub
          </a>
          <a
            href="https://www.npmjs.com/package/peer-term"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackLandingEvent('outbound_click', { target: 'npm', location: 'footer' })}
          >
            npm
          </a>
          <a
            href="https://linkedin.com/in/dhananjay-balekar"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackLandingEvent('outbound_click', { target: 'linkedin', location: 'footer' })}
          >
            LinkedIn
          </a>
          <a
            href="https://dhananjaybalekar.in"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackLandingEvent('outbound_click', { target: 'portfolio', location: 'footer' })}
          >
            Dhananjay Balekar
          </a>
        </div>
      </div>
    </footer>
  );
}
