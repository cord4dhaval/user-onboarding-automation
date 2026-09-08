import "./globals.css";
import type { ReactNode } from "react";
import { JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { themeScript } from "./theme";

// One family across both roles. Bricolage is an editorial face — its width axis and
// tighter counters read as personality on a headline and as noise on a console that is
// mostly labels and numbers. Plus Jakarta carries a real 800 for headings and a plain
// 400 for body, so the hierarchy comes from weight rather than from a second typeface.
const display = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
  variable: "--font-display",
  display: "swap",
});
const body = Plus_Jakarta_Sans({
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
