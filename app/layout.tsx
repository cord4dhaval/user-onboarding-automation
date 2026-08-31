import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Conversion Engine",
  description: "Goal-seeking outreach for any product",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
