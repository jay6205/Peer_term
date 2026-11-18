import { useState } from 'react';
import BootLoader from './components/BootLoader';
import Navbar from './components/Navbar';
import Hero from './components/Hero';
import EncryptionLab from './components/EncryptionLab';
import CapabilitiesDeck from './components/CapabilitiesDeck';
import HowItWorks from './components/HowItWorks';
import Comparison from './components/Comparison';
import FAQ from './components/FAQ';
import CTA from './components/CTA';
import Footer from './components/Footer';

export default function App() {
  const [heroReady, setHeroReady] = useState(false);
  const [overlayMounted, setOverlayMounted] = useState(true);

  return (
    <div className="app-shell">
      {overlayMounted && (
        <BootLoader
          onCurtainStart={() => setHeroReady(true)}
          onComplete={() => {
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
