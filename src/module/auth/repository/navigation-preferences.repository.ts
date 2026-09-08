import pool from "../../../config/database";
import type { NavigationPreferences } from "../validators/navigation-preferences.validators";

export async function findNavigationPreferences(userId: number): Promise<unknown | null> {
  const result = await pool.query<{ preferences: unknown }>(
    "SELECT preferences FROM public.user_navigation_preferences WHERE user_id = $1", [userId],
  );
  return result.rows[0]?.preferences ?? null;
}

export async function upsertNavigationPreferences(userId: number, preferences: NavigationPreferences): Promise<NavigationPreferences> {
  // One atomic upsert: the last successful write wins, including concurrent first saves.
  const result = await pool.query<{ preferences: NavigationPreferences }>(
    `INSERT INTO public.user_navigation_preferences (user_id, preferences)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET preferences = EXCLUDED.preferences, updated_at = clock_timestamp()
     RETURNING preferences`, [userId, JSON.stringify(preferences)],
  );
  return result.rows[0].preferences;
}
