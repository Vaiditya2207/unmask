const DOCS = "https://github.com/Vaiditya2207/unmask/tree/main/docs";
const CHECK = "/#check";

export interface Download {
  href: string;
  filename: string;
}

function Glyph() {
  return (
    <svg
      className="product-mark__glyph"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      aria-hidden="true"
    >
      <path className="product-mark__shape" d="M0 0H14L20 6V20H0Z" />
      <path
        className="product-mark__letter"
        d="M6.125 4.5V11a3.875 3.875 0 0 0 7.75 0V8.25"
      />
    </svg>
  );
}

// On the frame, with no rule under it. On a phone it keeps the mark, the release and a menu.
export function ViewerBar({
  crumb = "Reports",
  spec,
  download,
}: {
  crumb?: string;
  spec?: string;
  download?: Download;
}) {
  return (
    <header className="viewer-bar">
      <div className="viewer-bar__start">
        <a className="product-mark" href="/">
          <Glyph />
          <span className="product-mark__name">UNMASK</span>
        </a>
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <ol className="breadcrumb__list">
            <li>{crumb}</li>
            {spec ? (
              <>
                <li className="breadcrumb__sep" aria-hidden="true">
                  /
                </li>
                <li aria-current="page">{spec}</li>
              </>
            ) : null}
          </ol>
        </nav>
        {spec ? <p className="viewer-bar__title">{spec}</p> : null}
      </div>
      <div className="viewer-bar__end">
        <a className="viewer-bar__link" href={DOCS}>
          Docs
        </a>
        <a className="button button--compact" href={CHECK}>
          Check a release
        </a>
      </div>
      <details className="viewer-menu">
        <summary className="viewer-menu__button">
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            aria-hidden="true"
            className="viewer-menu__icon"
          >
            <path d="M3 6h14M3 10h14M3 14h14" />
          </svg>
          <span className="visually-hidden">Menu</span>
        </summary>
        <div className="viewer-menu__panel">
          {download ? (
            <a href={download.href} download={download.filename}>
              Download JSON
            </a>
          ) : null}
          <a href={DOCS}>Docs</a>
          <a href={CHECK}>Check a release</a>
        </div>
      </details>
    </header>
  );
}
