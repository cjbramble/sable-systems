import Link from 'next/link';

export function BrandWordmark() {
  return (
    <Link className="wordmark" href="/" aria-label="SABLE home">
      <span className="wordmark__sigil" aria-hidden="true">
        <i className="wordmark__diamond" />
        <i className="wordmark__orbit" />
        <span className="wordmark__axis">
          <i />
          <i />
          <i />
        </span>
      </span>
      <span>
        <strong>SABLE</strong>
        <small>Morrow Vale Holdings</small>
      </span>
    </Link>
  );
}
