"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

type Theme = "light" | "dark" | "system";

const OPTIONS: Array<{ key: Theme; label: string; icon: typeof Sun }> = [
  { key: "light", label: "Light", icon: Sun },
  { key: "dark", label: "Dark", icon: Moon },
  { key: "system", label: "System", icon: Monitor },
];

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

/**
 * The three options shown at once rather than a button that cycles through them. Inside a
 * menu there is room to say which state is current and what the alternatives are, which a
 * single cycling icon can only imply.
 */
export function ThemeChoice() {
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
    <div className="seg" role="group" aria-label="Theme">
      {OPTIONS.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          type="button"
          className={key === theme ? "on" : ""}
          aria-pressed={key === theme}
          onClick={() => {
            setTheme(key);
            applyTheme(key);
          }}
        >
          <Icon size={14} /> {label}
        </button>
      ))}
    </div>
  );
}

/**
 * Runs before first paint so a dark-mode reader never sees a flash of the cream ground.
 * Inline in the document head, deliberately tiny.
 */
export const themeScript = `try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
