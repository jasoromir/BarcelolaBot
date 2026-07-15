import type { GuidesConfig } from '../config/schemas.js';

/** Looks up a single guide's WhatsApp number by exact name match in guides.yaml. */
export function resolveGuidePhone(guides: GuidesConfig, guideName: string | undefined | null): string | null {
  if (!guideName) return null;
  const match = guides.guides.find((g) => g.active !== false && g.name === guideName);
  return match?.phone ?? null;
}

/**
 * Splits LLM-parsed multi-guide strings like "ליאנה/עדי" or "ליאנה, עדי" into
 * individual names. Private-tour calendar events sometimes list two guides
 * (e.g. a handoff), which a plain exact-match lookup against the combined
 * string would never resolve.
 */
export function parseGuideNames(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[/,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Resolves every guide name found in a (possibly multi-guide) raw string to its phone. */
export function resolveGuidePhones(guides: GuidesConfig, raw: string | null | undefined): string[] {
  return parseGuideNames(raw)
    .map((name) => resolveGuidePhone(guides, name))
    .filter((p): p is string => Boolean(p));
}
