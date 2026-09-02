import Link from 'next/link';
import {
  ArrowRight,
  Boxes,
  CircleDot,
  Cpu,
  MoveUpRight,
  ScanLine,
  ShieldCheck,
} from 'lucide-react';

const divisions = [
  { code: '01', label: 'Compute substrates', icon: Cpu },
  { code: '02', label: 'Neural interfaces', icon: ScanLine },
  { code: '03', label: 'Cybernetic systems', icon: CircleDot },
  { code: '04', label: 'Network security', icon: ShieldCheck },
];

export default function Home() {
  return (
    <main className="brand-page">
      <header className="brand-nav">
        <Link className="wordmark" href="/" aria-label="SABLE home">
          <span className="wordmark__sigil">S</span>
          <span>
            <strong>SABLE</strong>
            <small>Morrow Vale Holdings</small>
          </span>
        </Link>
        <nav aria-label="Primary navigation">
          <Link href="#systems">Systems</Link>
          <Link href="#mandate">Mandate</Link>
          <Link href="/support">COV-E Support</Link>
        </nav>
        <Link className="nav-cta" href="/shop">
          Enter procurement <MoveUpRight />
        </Link>
      </header>

      <section className="brand-hero">
        <div className="brand-hero__copy">
          <p className="brand-kicker">
            <span /> SABLE SYSTEMS // WHOLESALE DIRECTIVE 26.9
          </p>
          <h1>
            Infrastructure for the
            <em> post-human century.</em>
          </h1>
          <p className="brand-lede">
            Compute, interface, and augmentation systems engineered for the
            hard edge of tomorrow. Authorized wholesale access for Calder Pike
            Distribution.
          </p>
          <div className="brand-actions">
            <Link className="brand-primary" href="/shop">
              Browse systems <ArrowRight />
            </Link>
            <Link className="brand-secondary" href="/support">
              Contact COV-E
            </Link>
          </div>
          <div className="brand-proof">
            <div><strong>17</strong><span>Active systems</span></div>
            <div><strong>04</strong><span>Fulfillment nodes</span></div>
            <div><strong>99.98</strong><span>Chain integrity</span></div>
          </div>
        </div>

        <div className="sigil-stage" aria-label="SABLE three-dimensional brand mark">
          <div className="sigil-orbit sigil-orbit--one" />
          <div className="sigil-orbit sigil-orbit--two" />
          <div className="sigil-core">
            <span aria-hidden="true">S</span>
          </div>
          <p>MVH // SIGNAL VERIFIED</p>
        </div>
      </section>

      <section className="brand-ticker" aria-label="SABLE capabilities">
        <span>NEURAL I/O</span><i />
        <span>WAFER COMPUTE</span><i />
        <span>HAPTIC CONTROL</span><i />
        <span>SYNTHETIC TENDONS</span><i />
        <span>ZERO-TRUST MESH</span>
      </section>

      <section className="systems-section" id="systems">
        <div className="section-heading">
          <p>Catalog architecture</p>
          <h2>Systems that move civilization forward.</h2>
          <span>Designed in the North Atlantic Trade District. Deployed everywhere.</span>
        </div>
        <div className="division-grid">
          {divisions.map(({ code, label, icon: Icon }) => (
            <Link href="/shop" key={code}>
              <span className="division-code">SBL / {code}</span>
              <Icon />
              <strong>{label}</strong>
              <ArrowRight />
            </Link>
          ))}
        </div>
      </section>

      <section className="mandate-section" id="mandate">
        <div>
          <p className="brand-kicker"><span /> THE SABLE MANDATE</p>
          <h2>Tomorrow is a supply chain.</h2>
        </div>
        <p>
          We build the critical layer between human intent and machine action.
          Every SABLE component is serialized, traceable, and routed through
          verified wholesale channels.
        </p>
        <Link href="/shop"><Boxes /> Access live inventory <ArrowRight /></Link>
      </section>
    </main>
  );
}
