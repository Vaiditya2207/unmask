import type { Metadata, Viewport } from "next";
import manifest from "../public/fonts/manifest.json";
import "./fonts.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "UNMASK · See what actually shipped",
  description:
    "UNMASK compares a published npm release with the source commit it claims, file by file, and shows the evidence for every difference.",
};

export const viewport: Viewport = {
  themeColor: "#0f0f0f",
  colorScheme: "dark light",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {manifest.assets
          .filter((font) => font.preload)
          .map((font) => (
            <link
              key={font.sha256}
              rel="preload"
              href={`/fonts/${font.file}`}
              as="font"
              type="font/woff2"
              crossOrigin="anonymous"
            />
          ))}
        <script
          dangerouslySetInnerHTML={{
            __html: "document.documentElement.classList.add('js')",
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
