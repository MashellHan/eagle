import { z } from "zod";
import type { Viewer } from "../shared/schema.ts";

const ProfileSchema = z.object({
  name: z.string().trim().max(120).nullish(),
  avatar: z
    .url()
    .max(2048)
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    })
    .nullish(),
});

export async function withProfile(viewer: Viewer): Promise<Viewer> {
  if (!viewer.email) return viewer;
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(viewer.email),
    );
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const response = await fetch(
      `https://lizheng.blog/api/authors/profile?hash=${hash}`,
      {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(2500),
      },
    );
    if (!response.ok) return viewer;
    const profile = ProfileSchema.parse(await response.json());
    return {
      ...viewer,
      name: profile.name || viewer.name,
      avatar: profile.avatar || null,
    };
  } catch {
    return viewer;
  }
}
