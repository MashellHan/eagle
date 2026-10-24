import { ThemeProvider, TooltipProvider } from "@nocoo/basalt";
import { AccentProvider } from "@nocoo/basalt/providers/accent";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { TimezoneProvider } from "./Timezone.tsx";
import "./style.css";

let theme: string | null = null;
try {
  theme = localStorage.getItem("theme");
} catch {
  /* Browser may restrict preferences. */
}
const dark =
  theme === "dark" ||
  (theme !== "light" &&
    (theme !== "system" || matchMedia("(prefers-color-scheme: dark)").matches));
document.documentElement.classList.toggle("dark", dark);
document.documentElement.classList.toggle("light", !dark);
document.documentElement.dataset.mode = dark ? "dark" : "light";
const root = document.getElementById("root");
if (!root) throw new Error("Missing app root");
createRoot(root).render(
  <ThemeProvider defaultTheme="dark">
    <AccentProvider defaultAccent="primary">
      <TooltipProvider>
        <TimezoneProvider>
          <App />
        </TimezoneProvider>
      </TooltipProvider>
    </AccentProvider>
  </ThemeProvider>,
);
