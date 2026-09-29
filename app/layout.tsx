import "./globals.css";
import type { ReactNode } from "react";
import { Figtree, JetBrains_Mono } from "next/font/google";
import { themeScript } from "./theme";

// One family across both roles. Figtree is round and open, so a screen of labels and short
// rows reads as friendly rather than technical, and its 800 is heavy enough to carry a page
// title on weight alone. The mono face is kept for counts and IDs only — never for a label.
const display = Figtree({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-display",
  display: "swap",
});
const body = Figtree({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
  display: "swap",
});
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata = {
  title: "Engine",
  description: "Goal-seeking outreach for any product",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The theme script stamps data-theme before hydration, so the server markup and the
    // client DOM differ by design on this one element.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${display.variable} ${body.variable} ${mono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
