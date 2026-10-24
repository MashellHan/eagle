import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

const KEY = "eagle-timezone-offset";
export const TIMEZONE_OFFSETS = [
  ...new Set([
    ...Array.from({ length: 27 }, (_, n) => (n - 12) * 60),
    -570,
    -210,
    210,
    270,
    330,
    345,
    390,
    525,
    570,
    630,
    765,
  ]),
].sort((a, b) => a - b);
export const timezoneLabel = (offset: number) =>
  `UTC${offset < 0 ? "−" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
function parseOffset(value: string | null) {
  return value !== null && TIMEZONE_OFFSETS.includes(Number(value))
    ? Number(value)
    : 480;
}
function readOffset() {
  try {
    return parseOffset(localStorage.getItem(KEY));
  } catch {
    return 480;
  }
}
const TimezoneContext = createContext({
  offset: 480,
  setOffset: (_offset: number) => {},
  persisted: true,
});
export function TimezoneProvider({ children }: { children: ReactNode }) {
  const [offset, updateOffset] = useState(readOffset);
  const [persisted, setPersisted] = useState(true);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === KEY || event.key === null) updateOffset(readOffset());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const setOffset = (next: number) => {
    if (!TIMEZONE_OFFSETS.includes(next)) return;
    updateOffset(next);
    try {
      localStorage.setItem(KEY, String(next));
      setPersisted(true);
    } catch {
      setPersisted(false);
    }
  };
  return (
    <TimezoneContext value={{ offset, setOffset, persisted }}>
      {children}
    </TimezoneContext>
  );
}
export function useTimezone() {
  const context = useContext(TimezoneContext);
  return {
    ...context,
    zone: timezoneLabel(context.offset),
    time: (iso: string, options?: Intl.DateTimeFormatOptions) => {
      const date = new Date(Date.parse(iso) + context.offset * 60000);
      if (!Number.isFinite(date.getTime())) return "时间未知";
      return date.toLocaleString("zh-CN", {
        ...(options ?? {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
        timeZone: "UTC",
        hour12: false,
      });
    },
  };
}
