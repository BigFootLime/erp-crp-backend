import { HttpError } from "../../../utils/httpError";
import { findNavigationPreferences, upsertNavigationPreferences } from "../repository/navigation-preferences.repository";
import { defaultNavigationPreferences, navigationPreferencesSchema } from "../validators/navigation-preferences.validators";

export async function readNavigationPreferences(userId: number) {
  const stored = await findNavigationPreferences(userId);
  if (stored === null) return defaultNavigationPreferences();
  const parsed = navigationPreferencesSchema.safeParse(stored);
  if (!parsed.success) throw new HttpError(503, "NAVIGATION_PREFERENCES_UNAVAILABLE", "Les préférences de navigation sont temporairement indisponibles.");
  return parsed.data;
}

export async function saveNavigationPreferences(userId: number, input: unknown) {
  return upsertNavigationPreferences(userId, navigationPreferencesSchema.parse(input));
}
