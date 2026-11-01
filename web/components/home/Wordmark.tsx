export function Wordmark({ href }: { href: string }) {
  return (
    <a className="wordmark" href={href} aria-label="UNMASK home">
      <svg className="wordmark-mark" viewBox="0 0 22 22" aria-hidden="true">
        <rect className="wordmark-field" width="22" height="22" rx="6" />
        <rect
          className="wordmark-slot"
          x="4"
          y="11"
          width="14"
          height="6"
          rx="2"
        />
      </svg>
      <span>UNMASK</span>
    </a>
  );
}
