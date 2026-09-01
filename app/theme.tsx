"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

const LABEL: Record<Theme, string> = { light: "Light", dark: "Dark", system: "System" };
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

/**
 * Three states, not two. "System" leaves the root element unstamped so the media query
 * decides; an explicit choice stamps it and wins over the operating system either way.
 */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("theme", theme);
  } catch {
    // Private windows and blocked site data both throw. The choice simply does not persist.
  }
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    try {
      const stored = localStorage.getItem("theme");
      if (stored === "light" || stored === "dark") setTheme(stored);
    } catch {
      /* no stored preference available */
    }
  }, []);

  return (
    <button
      type="button"
      className="quiet sm"
      title={`Theme: ${LABEL[theme]}`}
      aria-label={`Theme: ${LABEL[theme]}. Change`}
      onClick={() => {
        const next = NEXT[theme];
        setTheme(next);
        applyTheme(next);
      }}
    >
      {theme === "dark" ? "◗" : theme === "light" ? "◒" : "◐"} {LABEL[theme]}
    </button>
  );
}

/**
 * Runs before first paint so a dark-mode reader never sees a flash of the cream ground.
 * Inline in the document head, deliberately tiny.
 */
export const themeScript = `try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
