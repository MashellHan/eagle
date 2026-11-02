import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";

/**
 * The person's standing instruction, the first thing a bot reads (docs/bots/PRODUCT.md,
 * "Core prompts"). It is set once for the whole machine in Settings, so every bot starts from
 * the same expectation; a page with no text renders nothing at all.
 */
export const PERSONA_EXTENSION = "bots-persona";
export const PERSONA_SECTION = "bots-persona";

export type PersonaReader = () => string | undefined;

export const personaExtension = (read: PersonaReader): Extension =>
  defineExtension({
    name: PERSONA_EXTENSION,
    tools: [],
    sections: [
      section(PERSONA_SECTION, () => {
        const text = read()?.trim();
        return text === undefined || text.length === 0 ? undefined : text;
      }),
    ],
  });
