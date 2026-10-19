import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readStationOfflineInstallationId(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.CERP_INSTALLATION_ID?.trim().toLowerCase();
  return value && UUID.test(value) ? value : null;
}

export function stationOfflineScope(input: { installationId: string; database: string; deviceId: string }): string {
  const digest = createHash("sha256")
    .update(`cerp:station-offline-scope:v2\0${input.installationId}\0${input.database}\0${input.deviceId}`)
    .digest("base64url");
  return `v2.${digest}`;
}

export async function resolveStationOfflineScope(
  query: { query<T>(text: string): Promise<{ rows: T[] }> },
  deviceId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const installationId = readStationOfflineInstallationId(env);
  if (!installationId) return null;
  const database = (await query.query<{ database: string }>("SELECT current_database() AS database")).rows[0]?.database;
  return database ? stationOfflineScope({ installationId, database, deviceId }) : null;
}
