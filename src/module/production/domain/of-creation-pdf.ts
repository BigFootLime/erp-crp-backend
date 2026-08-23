import type { PoolClient } from "pg";

import { queueCreationPdfArchive } from "../../../shared/authoritative-documents/authoritative-document.service";
import { buildInternalCreationSnapshot } from "../../../shared/authoritative-documents/internal-creation-snapshot";

type Queryable = Pick<PoolClient, "query">;

type RootOfRow = {
  id: string;
  numero: string;
  root_of_id: string | null;
  parent_of_id: string | null;
  generation_level: number;
  piece_technique_id: string | null;
  piece_technique_version_id: string | null;
  technical_snapshot_sha256: string | null;
  commande_id: string | null;
  affaire_id: string | null;
  client_id: string | null;
  client_name: string | null;
  quantite_lancee: number;
  statut: string;
  priority: string;
  date_lancement_prevue: string | null;
  date_fin_prevue: string | null;
  updated_at: string;
};

/**
 * Queues exactly one internal creation snapshot for a meaningful OF root.
 * The test in SQL (rather than only caller convention) ensures child OFs can
 * never accidentally acquire their own creation PDF when a recursive tree is
 * generated.  Queueing is intentionally part of the caller's DB transaction.
 */
export async function queueRootOfCreationPdf(
  tx: Queryable,
  params: { ofId: number; actorUserId: number | null }
): Promise<void> {
  const rootRes = await tx.query<RootOfRow>(
    `
      SELECT o.id::text AS id,
             o.numero,
             o.root_of_id::text AS root_of_id,
             o.parent_of_id::text AS parent_of_id,
             COALESCE(o.generation_level, 0)::int AS generation_level,
             o.piece_technique_id::text AS piece_technique_id,
             o.piece_technique_version_id::text AS piece_technique_version_id,
             o.technical_snapshot_sha256,
             o.commande_id::text AS commande_id,
             o.affaire_id::text AS affaire_id,
             o.client_id::text AS client_id,
             c.company_name AS client_name,
             o.quantite_lancee::float8 AS quantite_lancee,
             o.statut::text AS statut,
             o.priority::text AS priority,
             o.date_lancement_prevue::text AS date_lancement_prevue,
             o.date_fin_prevue::text AS date_fin_prevue,
             to_char(o.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
        FROM public.ordres_fabrication o
        LEFT JOIN public.clients c ON c.client_id = o.client_id
       WHERE o.id = $1::bigint
         AND o.parent_of_id IS NULL
         AND (o.root_of_id IS NULL OR o.root_of_id = o.id)
       FOR UPDATE OF o
    `,
    [params.ofId]
  );
  const root = rootRes.rows[0];
  if (!root) return;
  if (!root.updated_at) throw new Error("OF_CREATION_PDF_SOURCE_REVISION_MISSING");

  const operations = await tx.query<Record<string, unknown>>(
    `SELECT phase::int AS phase, designation, status::text AS status,
            cf_code_snapshot, numero_programme
       FROM public.of_operations
      WHERE of_id = $1::bigint
      ORDER BY phase ASC, id ASC`,
    [root.id]
  );

  await queueCreationPdfArchive(tx, {
    entityType: "ordre-fabrication",
    entityId: root.id,
    documentKind: "OF_CREATION_SNAPSHOT",
    documentVersion: 1,
    renderVersion: "of-creation-snapshot-v1",
    idempotencyKey: `ordre-fabrication:${root.id}:creation:v1`,
    title: `Création OF ${root.numero}`,
    originalName: `of-${root.id}-creation-v1.pdf`,
    sourceRevision: root.updated_at,
    sourceSnapshot: buildInternalCreationSnapshot({
      entityLabel: "Ordre de fabrication — instantané de création",
      reference: root.numero,
      summary: [
        { label: "OF", value: root.numero }, { label: "Statut initial", value: root.statut },
        { label: "Priorité", value: root.priority }, { label: "Quantité lancée", value: root.quantite_lancee },
        { label: "Commande", value: root.commande_id }, { label: "Affaire", value: root.affaire_id },
        { label: "Client", value: root.client_name ?? root.client_id }, { label: "Version pièce", value: root.piece_technique_version_id },
      ],
      sections: [
        { title: "Pièce technique", rows: [
          { label: "Référence", value: root.piece_technique_id }, { label: "Version", value: root.piece_technique_version_id },
          { label: "Empreinte du snapshot", value: root.technical_snapshot_sha256 },
        ] },
        { title: "Planification", rows: [
          { label: "Début prévu", value: root.date_lancement_prevue }, { label: "Fin prévue", value: root.date_fin_prevue },
        ] },
        { title: "Opérations", table: { columns: [{ key: "phase", label: "Phase" }, { key: "designation", label: "Désignation" }, { key: "status", label: "Statut" }, { key: "workcenter", label: "Centre" }], rows: operations.rows.map((operation) => ({ phase: operation.phase == null ? null : String(operation.phase), designation: operation.designation == null ? null : String(operation.designation), status: operation.status == null ? null : String(operation.status), workcenter: operation.cf_code_snapshot == null ? null : String(operation.cf_code_snapshot) })) } },
      ],
    }),
    actorUserId: params.actorUserId,
  });
}
