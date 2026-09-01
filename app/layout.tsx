import "./globals.css";
import type { ReactNode } from "react";
import { Bricolage_Grotesque, JetBrains_Mono, Manrope } from "next/font/google";
import { themeScript } from "./theme";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  axes: ["opsz", "wdth"],
  variable: "--font-display",
  display: "swap",
});
const body = Manrope({ subsets: ["latin"], variable: "--font-body", display: "swap" });
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
