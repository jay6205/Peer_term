import { useEffect, useRef, useState } from 'react';
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';
import BootLoader from './components/BootLoader';
import CustomCursor from './components/CustomCursor';
import Navbar from './components/Navbar';
import Hero from './components/Hero';
import EncryptionLab from './components/EncryptionLab';
import CapabilitiesDeck from './components/CapabilitiesDeck';
import HowItWorks from './components/HowItWorks';
import Comparison from './components/Comparison';
import FAQ from './components/FAQ';
import CTA from './components/CTA';
import Footer from './components/Footer';

const BOT_UA_PATTERN =
  /bot|crawl|spider|lighthouse|pagespeed|chrome-lighthouse|headless|prerender|slurp|bingpreview|facebookexternalhit|twitterbot|discordbot|slackbot|whatsapp/i;

function shouldSkipBootLoader() {
  if (typeof window === 'undefined') return true;
  if (window.navigator?.webdriver) return true;
  if (BOT_UA_PATTERN.test(window.navigator?.userAgent || '')) return true;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true;
  try {
    if (window.sessionStorage?.getItem('peerterm_booted') === '1') return true;
  } catch {
    // Ignore storage restrictions
  }
  return false;
}

export default function App() {
  const [skipInitial] = useState(() => shouldSkipBootLoader());
  const [heroReady, setHeroReady] = useState(skipInitial);
  const [overlayMounted, setOverlayMounted] = useState(!skipInitial);
  const lenisRef = useRef(null);

  // Initialize Lenis smooth scroll
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const lenis = new Lenis({
      duration: 1.15,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      orientation: 'vertical',
      gestureOrientation: 'vertical',
      smoothWheel: true,
      wheelMultiplier: 0.95,
      touchMultiplier: 1.5,
      infinite: false,
    });

    lenisRef.current = lenis;
    window.__lenis = lenis;

    let rafId;
    function raf(time) {
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    }
    rafId = requestAnimationFrame(raf);

    return () => {
      cancelAnimationFrame(rafId);
      lenis.destroy();
      lenisRef.current = null;
      delete window.__lenis;
    };
  }, []);

  // Pause scrolling while BootLoader curtain is actively displayed
  useEffect(() => {
    if (!lenisRef.current) return;
    if (overlayMounted) {
      lenisRef.current.stop();
    } else {
      lenisRef.current.start();
    }
  }, [overlayMounted]);

  const markBooted = () => {
    try {
      window.sessionStorage?.setItem('peerterm_booted', '1');
    } catch {
      // Ignore storage restrictions
    }
  };

  return (
    <div className="app-shell">
      <CustomCursor />
      {overlayMounted && (
        <BootLoader
          onCurtainStart={() => {
            markBooted();
            setHeroReady(true);
          }}
          onComplete={() => {
            markBooted();
            setHeroReady(true);
            setOverlayMounted(false);
          }}
        />
      )}
      <Navbar booted={heroReady} />
      <main>
        <Hero booted={heroReady} />
        <EncryptionLab />
        <CapabilitiesDeck />
        <HowItWorks />
        <Comparison />
        <FAQ />
        <CTA />
      </main>
      <Footer />
    </div>
  );
}
