import '../styles/Footer.css';

export default function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <span className="footer-logo">⬡</span>
          <span>PeerTerm</span>
        </div>
        <div className="footer-links">
          <a href="https://github.com/jay6205/Peer_term" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a href="https://www.npmjs.com/package/peer-term" target="_blank" rel="noopener noreferrer">
            npm
          </a>
          <a href="https://linkedin.com/in/dhananjay-balekar" target="_blank" rel="noopener noreferrer">
            LinkedIn
          </a>
        </div>
        <p className="footer-copy">
          Built by{' '}
          <a href="https://dhananjaybalekar.in" target="_blank" rel="noopener noreferrer">
            Dhananjay Balekar
          </a>{' '}
          · Open Source under MIT
        </p>
      </div>
    </footer>
  );
}
