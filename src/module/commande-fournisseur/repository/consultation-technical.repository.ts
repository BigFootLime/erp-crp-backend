import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import {
  consultationSnapshotKey,
  type ConsultationTechnicalSource,
} from "../domain/supplier-consultation";
import { PURCHASE_OF_ORIGIN_CTES } from "./purchase-client-context.repository";

/** Reference-only projection. Never return manufacturing costs or GED bytes. */
export const CONSULTATION_TECHNICAL_SQL = `WITH ${PURCHASE_OF_ORIGIN_CTES}, recipients AS (
  SELECT line_id,of_id FROM origins UNION SELECT line_id,of_id FROM effective_origins
), dossier AS (
  SELECT r.line_id,o.id AS of_id,o.numero AS of_code,o.piece_technique_id,
    COALESCE(o.piece_technique_version_id,NULLIF(o.technical_preparation->>'selected_version_id','')::uuid) AS version_id,
    o.technical_snapshot_sha256 AS manufacturing_sha256,o.technical_snapshot,o.technical_preparation,
    COALESCE(CASE WHEN o.technical_snapshot_sha256 IS NOT NULL THEN o.material_origin_limit=1 ELSE pt.piece_critique END,false) AS critical,
    CASE WHEN o.technical_snapshot_sha256 IS NOT NULL THEN o.technical_snapshot->'piece'->>'code' ELSE pt.code_piece END AS piece_code,
    CASE WHEN o.technical_snapshot_sha256 IS NOT NULL THEN o.technical_snapshot->'piece'->>'designation' ELSE pt.designation END AS designation
  FROM recipients r JOIN public.ordres_fabrication o ON o.id=r.of_id
  LEFT JOIN public.pieces_techniques pt ON pt.id=o.piece_technique_id
), sources AS (
  SELECT d.*,v.indice,v.version_interne,v.plan_reference,to_jsonb(v) AS version_state,
    CASE WHEN d.manufacturing_sha256 IS NOT NULL THEN d.technical_snapshot->'version'
      ELSE jsonb_build_object('plan_reference',v.plan_reference,'indice_externe',v.indice,'version_interne',v.version_interne) END AS selected_version,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('code',q.document_type_code,'label',q.document_type_label,'policy',q.policy)
      ORDER BY q.document_type_code) FROM public.piece_version_document_requirements q
      WHERE q.piece_technique_version_id=d.version_id AND q.policy<>'NONE'
        AND (q.policy<>'PER_PT_CRITICAL' OR d.critical)),'[]'::jsonb) AS required_documents,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('document_id',g.id,'version_id',gv.id,'sha256',b.sha256,'role',link.link_role)
      ORDER BY g.id,gv.id,link.link_role) FROM public.ged_document_links link
      JOIN public.ged_documents g ON g.id=link.document_id AND g.archived_at IS NULL
      JOIN public.ged_document_versions gv ON gv.id=g.current_version_id AND gv.status='APPLICABLE'
      JOIN public.ged_blobs b ON b.id=gv.blob_id
      WHERE link.entity_type='PIECE_TECHNIQUE_VERSION' AND link.entity_id=d.version_id::text),'[]'::jsonb) AS draft_document_state
  FROM dossier d LEFT JOIN public.piece_technique_versions v ON v.id=d.version_id
) SELECT line_id::text,of_id::int,of_code,piece_technique_id::text,piece_code,designation,version_id::text,
  selected_version->>'plan_reference' AS plan_reference,selected_version->>'indice_externe' AS external_index,
  NULLIF(selected_version->>'version_interne','')::int AS internal_version,critical,required_documents,
  manufacturing_sha256,
  CASE WHEN manufacturing_sha256 IS NULL THEN jsonb_build_object('version',version_state,
    'preparation',technical_preparation,'documents',draft_document_state) ELSE NULL END AS draft_state
  FROM sources ORDER BY line_id,of_id LIMIT 5001`;

type TechnicalRow = Omit<
  ConsultationTechnicalSource,
  "source_sha256" | "manufacturing_frozen"
> & {
  manufacturing_sha256: string | null;
  draft_state: unknown;
};

export const CONSULTATION_OF_LOCK_SQL = `WITH ${PURCHASE_OF_ORIGIN_CTES}, recipients AS (
  SELECT of_id FROM origins UNION SELECT of_id FROM effective_origins
) SELECT o.id FROM public.ordres_fabrication o WHERE o.id IN(SELECT of_id FROM recipients) ORDER BY o.id FOR SHARE`;
export const CONSULTATION_VERSION_LOCK_SQL = `WITH ${PURCHASE_OF_ORIGIN_CTES}, recipients AS (
  SELECT of_id FROM origins UNION SELECT of_id FROM effective_origins
) SELECT v.id FROM public.piece_technique_versions v WHERE v.id IN(
  SELECT COALESCE(o.piece_technique_version_id,NULLIF(o.technical_preparation->>'selected_version_id','')::uuid)
  FROM public.ordres_fabrication o WHERE o.id IN(SELECT of_id FROM recipients)) ORDER BY v.id FOR SHARE`;

export async function readConsultationTechnicalSourcesTx(
  tx: Pick<PoolClient, "query">,
  orderId: string,
  lock = false,
): Promise<ConsultationTechnicalSource[]> {
  if (lock) {
    await tx.query(CONSULTATION_OF_LOCK_SQL, [orderId]);
    await tx.query(CONSULTATION_VERSION_LOCK_SQL, [orderId]);
  }
  const rows = (
    await tx.query<TechnicalRow>(CONSULTATION_TECHNICAL_SQL, [orderId])
  ).rows;
  if (rows.length > 5000)
    throw new HttpError(
      409,
      "CONSULTATION_SOURCE_LIMIT",
      "Scindez cette consultation : elle regroupe plus de 5000 dossiers OF.",
    );
  return rows.map(({ draft_state, manufacturing_sha256, ...reference }) => ({
    ...reference,
    manufacturing_frozen: manufacturing_sha256 !== null,
    manufacturing_sha256,
    source_sha256: crypto
      .createHash("sha256")
      .update(
        consultationSnapshotKey({
          reference,
          manufacturing_sha256,
          draft_state,
        }),
      )
      .digest("hex"),
  }));
}
