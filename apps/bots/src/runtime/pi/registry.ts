// The phase-1 extension set: empty. A tool, section or hook arrives with the capability
// that renders it (docs/bots/RUNTIME.md, "No tools"), so the registry stays the one place
// where an installed extension would appear.
import { createRegistry } from "@earendil-works/pi-durable";

export const createPhaseOneRegistry = () => createRegistry();
