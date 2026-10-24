import { useEffect, useState } from "react";

const KEY = "eagle-terminal-theme";
export const TERMINAL_THEMES = {
  auto: "跟随网页",
  dark: "深色终端",
  classic: "经典黑底",
  light: "浅色终端",
} as const;
type Theme = keyof typeof TERMINAL_THEMES;
const valid = (value: string | null): Theme =>
  value && Object.hasOwn(TERMINAL_THEMES, value) ? (value as Theme) : "auto";
const pageTheme = () =>
  document.documentElement.dataset.mode === "light" ? "light" : "dark";

export function useTerminalTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return valid(localStorage.getItem(KEY));
    } catch {
      return "auto";
    }
  });
  const [mode, setMode] = useState(pageTheme);
  const [persisted, setPersisted] = useState(true);
  useEffect(() => {
    const observer = new MutationObserver(() => setMode(pageTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-mode"],
    });
    const sync = (event: StorageEvent) => {
      if (event.key === KEY) {
        setTheme(valid(event.newValue));
        setPersisted(true);
      } else if (event.key === null) setTheme("auto");
    };
    window.addEventListener("storage", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("storage", sync);
    };
  }, []);
  const select = (value: string) => {
    const next = valid(value);
    setTheme(next);
    try {
      localStorage.setItem(KEY, next);
      setPersisted(true);
    } catch {
      setPersisted(false);
    }
  };
  return {
    theme,
    resolved: theme === "auto" ? mode : theme,
    select,
    persisted,
  };
}
