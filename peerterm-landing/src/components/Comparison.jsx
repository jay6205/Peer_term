import useScrollReveal from '../hooks/useScrollReveal';
import '../styles/Comparison.css';

const ROWS = [
  { feature: 'Browser-based viewer', peerterm: true, tmate: false, ssh: false },
  { feature: 'Zero install for viewer', peerterm: true, tmate: false, ssh: false },
  { feature: "E2E encryption (relay can't read data)", peerterm: true, tmate: false, ssh: true },
  { feature: 'Direct P2P (zero relay latency)', peerterm: true, tmate: false, ssh: false },
  { feature: 'Encrypted file upload', peerterm: true, tmate: false, ssh: 'SCP' },
  { feature: 'Works behind corporate firewall', peerterm: true, tmate: true, ssh: 'Port fwd' },
  { feature: 'Live read-only toggle', peerterm: true, tmate: false, ssh: false },
  { feature: 'No sudo / root required', peerterm: true, tmate: true, ssh: true },
  { feature: 'Cross-platform host', peerterm: true, tmate: 'macOS/Linux', ssh: true },
];

function Cell({ val }) {
  if (val === true) return <span className="cell-yes">✓</span>;
  if (val === false) return <span className="cell-no">✗</span>;
  return <span className="cell-partial">{val}</span>;
}

export default function Comparison() {
  const titleRef = useScrollReveal();
  const tableRef = useScrollReveal({ delay: 200 });

  return (
    <section id="comparison" className="comparison-section">
      <div className="section-inner">
        <div ref={titleRef}>
          <h2 className="section-title">How PeerTerm Compares</h2>
          <p className="section-subtitle">
            See how PeerTerm stacks up against tmate and traditional SSH screen sharing.
          </p>
        </div>
        <div ref={tableRef} className="table-wrapper">
          <table className="comparison-table">
            <thead>
              <tr>
                <th>Feature</th>
                <th className="col-peerterm">PeerTerm</th>
                <th>tmate</th>
                <th>SSH Share</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r, i) => (
                <tr key={i}>
                  <td className="feature-name">{r.feature}</td>
                  <td className="col-peerterm"><Cell val={r.peerterm} /></td>
                  <td><Cell val={r.tmate} /></td>
                  <td><Cell val={r.ssh} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
