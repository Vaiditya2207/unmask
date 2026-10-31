import type { Metadata, Viewport } from "next";
import {
  JetBrains_Mono,
  Libre_Franklin,
  Source_Serif_4,
} from "next/font/google";
import "./globals.css";

const display = Libre_Franklin({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

const text = Source_Serif_4({
  subsets: ["latin"],
  weight: ["400", "600"],
  style: ["normal", "italic"],
  variable: "--font-text",
  display: "swap",
});

const code = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-code",
  display: "swap",
});

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
    <html
      lang="en"
      className={`${display.variable} ${text.variable} ${code.variable}`}
      suppressHydrationWarning
    >
      <head>
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
