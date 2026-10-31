import { ViewerBar, type Download } from "@/components/report/ViewerBar";

// The frame and the white sheet every report screen sits on.
export function ReportShell({
  crumb,
  spec,
  download,
  children,
}: {
  crumb?: string;
  spec?: string;
  download?: Download;
  children: React.ReactNode;
}) {
  return (
    <div className="report-app">
      <a className="skip" href="#main">
        Skip to the report
      </a>
      <ViewerBar crumb={crumb} spec={spec} download={download} />
      <main className="report-sheet" id="main">
        <div className="report-column">{children}</div>
      </main>
    </div>
  );
}
