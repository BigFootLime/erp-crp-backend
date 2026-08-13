import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { qualitySha256 } from "../../qualite/domain/quality-policy";
import { HttpError } from "../../../utils/httpError";
import type { DeliveryQualityRelease } from "../domain/quality-release-gate";
import { repoGetDeliveryQualityRelease } from "./quality-release.repository";

export type DeliveryQualityDossierVersion = {
  id: string;
  bon_livraison_id: string;
  version: number;
  status: "FROZEN" | "REVOKED";
  policy_id: string;
  policy_sha256: string;
  release_preview_sha256: string;
  dossier_sha256: string;
  release_snapshot: DeliveryQualityRelease;
  evidence_manifest: DeliveryQualityRelease["required_evidence"];
  freeze_reason: string;
  frozen_by: number;
  frozen_at: string;
  revoked_by: number | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  created_at: string;
};

const DOSSIER_COLUMNS = `
  id::text AS id, bon_livraison_id::text AS bon_livraison_id, version, status,
  policy_id::text AS policy_id, policy_sha256, release_preview_sha256, dossier_sha256,
  release_snapshot, evidence_manifest, freeze_reason, frozen_by,
  frozen_at::text AS frozen_at, revoked_by, revoked_at::text AS revoked_at,
  revocation_reason, created_at::text AS created_at
`;

async function selectVersions(
  q: Pick<PoolClient, "query">,
  bonLivraisonId: string
): Promise<DeliveryQualityDossierVersion[]> {
  const result = await q.query<DeliveryQualityDossierVersion>(
    `SELECT ${DOSSIER_COLUMNS}
     FROM public.quality_delivery_dossier_versions
     WHERE bon_livraison_id = $1::uuid
     ORDER BY version DESC, id DESC`,
    [bonLivraisonId]
  );
  return result.rows;
}

export async function repoGetDeliveryQualityDossier(
  bonLivraisonId: string,
  q: Pick<PoolClient, "query"> = pool
): Promise<{
  release: DeliveryQualityRelease;
  latest: DeliveryQualityDossierVersion | null;
  versions: DeliveryQualityDossierVersion[];
  is_current: boolean;
}> {
  const [release, versions] = await Promise.all([
    repoGetDeliveryQualityRelease(bonLivraisonId, q),
    selectVersions(q, bonLivraisonId),
  ]);
  const latest = versions.find((version) => version.status === "FROZEN") ?? null;
  return {
    release,
    latest,
    versions,
    is_current:
      latest !== null &&
      latest.release_preview_sha256 === release.preview_sha256 &&
      latest.policy_sha256 === release.policy?.rules_sha256,
  };
}

export async function repoFreezeDeliveryQualityDossier(params: {
  bonLivraisonId: string;
  expectedPreviewSha256: string;
  reason: string;
  actorUserId: number;
  idempotencyKey: string;
}): Promise<DeliveryQualityDossierVersion> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, $2::bigint))`, [params.idempotencyKey, params.actorUserId]);
    const replay = await client.query<DeliveryQualityDossierVersion>(
      `SELECT ${DOSSIER_COLUMNS}
       FROM public.quality_delivery_dossier_versions
       WHERE frozen_by = $1 AND idempotency_key = $2`,
      [params.actorUserId, params.idempotencyKey]
    );
    if (replay.rows[0]) {
      if (replay.rows[0].bon_livraison_id !== params.bonLivraisonId) {
        throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette Idempotency-Key designe un autre dossier.");
      }
      await client.query("COMMIT");
      return replay.rows[0];
    }

    const delivery = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM public.bon_livraison WHERE id = $1::uuid FOR UPDATE`,
      [params.bonLivraisonId]
    );
    if (!delivery.rows[0]) throw new HttpError(404, "NOT_FOUND", "Bon de livraison introuvable.");

    const release = await repoGetDeliveryQualityRelease(params.bonLivraisonId, client);
    if (release.preview_sha256 !== params.expectedPreviewSha256) {
      throw new HttpError(409, "QUALITY_PREVIEW_STALE", "La decision qualite a change : rechargez le dossier.");
    }
    if ((release.state !== "READY" && release.state !== "DEROGATED") || !release.policy) {
      throw new HttpError(409, "QUALITY_DOSSIER_NOT_RELEASABLE", "Le dossier ne peut etre fige tant que la liberation est bloquee.", { release });
    }
    const versionResult = await client.query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0)::int + 1 AS version
       FROM public.quality_delivery_dossier_versions
       WHERE bon_livraison_id = $1::uuid`,
      [params.bonLivraisonId]
    );
    const version = versionResult.rows[0]!.version;
    const canonical = {
      schema: "cerp.quality.delivery-dossier.v1",
      bon_livraison_id: params.bonLivraisonId,
      version,
      policy: release.policy,
      release,
      evidence_manifest: release.required_evidence,
      freeze_reason: params.reason,
    };
    const inserted = await client.query<DeliveryQualityDossierVersion>(
      `INSERT INTO public.quality_delivery_dossier_versions (
         bon_livraison_id, version, policy_id, policy_sha256,
         release_preview_sha256, dossier_sha256, release_snapshot,
         evidence_manifest, freeze_reason, frozen_by, idempotency_key
       ) VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
       RETURNING ${DOSSIER_COLUMNS}`,
      [params.bonLivraisonId, version, release.policy.id, release.policy.rules_sha256, release.preview_sha256, qualitySha256(canonical), JSON.stringify(release), JSON.stringify(release.required_evidence), params.reason, params.actorUserId, params.idempotencyKey]
    );
    await client.query("COMMIT");
    return inserted.rows[0]!;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoRevokeDeliveryQualityDossier(params: {
  bonLivraisonId: string;
  versionId: string;
  reason: string;
  actorUserId: number;
}): Promise<DeliveryQualityDossierVersion> {
  const result = await pool.query<DeliveryQualityDossierVersion>(
    `UPDATE public.quality_delivery_dossier_versions
     SET status = 'REVOKED', revoked_by = $3, revoked_at = now(), revocation_reason = $4
     WHERE id = $1::uuid AND bon_livraison_id = $2::uuid AND status = 'FROZEN'
     RETURNING ${DOSSIER_COLUMNS}`,
    [params.versionId, params.bonLivraisonId, params.actorUserId, params.reason]
  );
  if (!result.rows[0]) throw new HttpError(404, "NOT_FOUND", "Version de dossier qualite active introuvable.");
  return result.rows[0];
}
