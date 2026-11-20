import { useState } from 'react';
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
