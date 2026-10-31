export function ViewerBar({ spec }: { spec?: string }) {
  return (
    <header className="viewer-bar">
      <div className="viewer-bar-inner">
        <nav aria-label="Breadcrumb" className="crumbs">
          <a href="/" className="mark">
            <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
              <rect
                x="1"
                y="1"
                width="18"
                height="18"
                rx="3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M5 7v4.5a2.5 2.5 0 0 0 5 0V7M12 13V7l3 3.5L18 7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
            UNMASK
          </a>
          <span aria-hidden="true">/</span>
          <span>Reports</span>
          {spec ? (
            <>
              <span aria-hidden="true">/</span>
              <code aria-current="page">{spec}</code>
            </>
          ) : null}
        </nav>
        <a className="bar-link" href="/#check">
          Check another release
        </a>
      </div>
    </header>
  );
}
