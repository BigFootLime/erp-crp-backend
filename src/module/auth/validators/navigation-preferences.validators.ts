import { z } from "zod";

// Stable catalogue identifiers only: never URLs, labels or account identifiers.
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const identifiers = z.array(identifier).max(256).refine((v) => new Set(v).size === v.length, "Identifiants dupliqués");
const viewSchema = z.object({
  groupOrder: identifiers,
  itemOrder: z.record(identifier, identifiers).refine((v) => Object.keys(v).length <= 64, "Trop de rubriques"),
  hiddenGroupIds: identifiers,
  hiddenPageKeys: identifiers,
  favoritePageKeys: identifiers,
}).strict();

export const navigationPreferencesSchema = z.object({
  schemaVersion: z.literal(1),
  side: z.enum(["left", "right"]),
  activeView: z.enum(["current", "global", "production"]),
  views: z.object({ current: viewSchema, global: viewSchema, production: viewSchema }).strict(),
}).strict().refine(v => JSON.stringify(v).length <= 65536, "Préférences trop volumineuses");

export type NavigationPreferences = z.infer<typeof navigationPreferencesSchema>;

export function defaultNavigationPreferences(): NavigationPreferences {
  const empty = () => ({ groupOrder: [], itemOrder: {}, hiddenGroupIds: [], hiddenPageKeys: [], favoritePageKeys: [] });
  return { schemaVersion: 1, side: "left", activeView: "current", views: { current: empty(), global: empty(), production: empty() } };
}
