import crypto from "node:crypto";
import pool from "../../config/database";
import { readSupplierContractTermsTx } from "./supplier-contract-terms.repository";
import { HttpError } from "../../utils/httpError";
import { assertGedVersionParentReadable } from "../../module/ged/services/ged-parent-authorization.service";
import {
  repoInternalGetVersionContentRef,
  repoLogAccess,
} from "../../module/ged/repository/ged.repository";
import { readBlob } from "../../module/ged/services/ged-vault.service";
import { repoGetAuthoritativePdf } from "../authoritative-documents/authoritative-document.repository";
import { canonicalJson } from "../authoritative-documents/authoritative-document.service";
import {
  generalTermsSnapshotSchema,
  selectGeneralTermsSchema,
  termsKind,
  type CommercialTermsScope,
  type GeneralTermsSnapshot,
} from "./commercial-terms.domain";
import {
  hasApprovedTerms,
  lockTermsParent,
  readTermsSelection,
  readTermsVersion,
  touchTermsParent,
} from "./commercial-terms.repository";

export async function getGeneralTerms(
  scope: CommercialTermsScope,
  entityId: string,
  actor: number,
) {
  const selection = await readTermsSelection(pool, scope, entityId);
  const inherited = scope === "commande-fournisseur" ? await readSupplierContractTermsTx(pool,entityId) : null;
  const candidates = await pool.query(
    `SELECT v.id::text FROM public.ged_documents d JOIN public.ged_document_versions v ON v.document_id=d.id
    WHERE d.class_key=$1 AND d.archived_at IS NULL AND v.status='APPLICABLE' ORDER BY d.code LIMIT 100`,
    [`CERP_${termsKind(scope)}`],
  );
  const choices: GeneralTermsSnapshot[] = [];
  for (const row of candidates.rows) {
    const version = await readTermsVersion(pool, scope, row.id);
    if (!version) continue;
    try {
      await assertGedVersionParentReadable(actor, version.document_id);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) continue;
      throw error;
    }
    choices.push(version);
  }
  const archives = await pool.query(
    `SELECT a.id::text,a.original_name,a.source_snapshot->'general_terms' AS terms,a.document_version
    FROM public.authoritative_pdf_archives a JOIN public.authoritative_pdf_archive_outbox o ON o.archive_id=a.id
    WHERE a.entity_type=$1 AND a.entity_id=$2 AND o.status='ARCHIVED'
    AND a.document_kind=$3 AND a.source_snapshot->'general_terms' IS NOT NULL AND a.source_snapshot->'general_terms'<>'null'::jsonb
    ORDER BY a.document_version DESC LIMIT 50`,
    [
      scope,
      entityId,
      scope === "devis"
        ? "CUSTOMER_QUOTE"
        : scope === "commande-client"
          ? "CUSTOMER_ORDER_ACKNOWLEDGEMENT"
          : "SUPPLIER_PURCHASE_ORDER",
    ],
  );
  const collection =
    scope === "commande-client" ? "acknowledgements" : "official-documents";
  const base =
    scope === "devis"
      ? "devis"
      : scope === "commande-client"
        ? "commandes"
        : "commandes-fournisseurs";
  return {
    kind: termsKind(scope),
    configured: await hasApprovedTerms(pool, scope),
    selection,
    inherited_from_contract: inherited !== null,
    selection_applicable: inherited ? true : selection
      ? Boolean(
          await readTermsVersion(pool, scope, selection.snapshot.version_id),
        )
      : false,
    choices,
    issued_documents: archives.rows.map((row) => ({
      id: row.id,
      filename: row.original_name,
      version: row.document_version,
      terms: generalTermsSnapshotSchema.parse(row.terms),
      download_path: `/${base}/${encodeURIComponent(entityId)}/${collection}/${row.id}/general-terms`,
    })),
  };
}

export async function selectGeneralTerms(
  scope: CommercialTermsScope,
  entityId: string,
  actor: number,
  body: unknown,
) {
  const input = selectGeneralTermsSchema.parse(body);
  const hash = crypto
    .createHash("sha256")
    .update(canonicalJson({ scope, entityId, actor, input }))
    .digest("hex");
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await lockTermsParent(tx, scope, entityId);
    const replay = await tx.query(
      `SELECT entity_type,entity_id,request_hash FROM public.commercial_general_terms_selections WHERE idempotency_key=$1::uuid`,
      [input.idempotency_key],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== hash)
        throw new HttpError(
          409,
          "GENERAL_TERMS_IDEMPOTENCY_CONFLICT",
          "Cette demande a déjà été utilisée avec d’autres conditions.",
        );
      await tx.query("COMMIT");
      return getGeneralTerms(scope, entityId, actor);
    }
    const current = await readTermsSelection(tx, scope, entityId);
    if ((current?.id ?? null) !== input.expected_selection_id)
      throw new HttpError(
        409,
        "GENERAL_TERMS_SELECTION_CONFLICT",
        "Les conditions ont changé. Actualisez le dossier avant de confirmer.",
      );
    const version = await readTermsVersion(tx, scope, input.version_id, true);
    if (!version)
      throw new HttpError(
        422,
        "GENERAL_TERMS_VERSION_UNAVAILABLE",
        "Choisissez un PDF approuvé, applicable et contrôlé dans la GED.",
      );
    await assertGedVersionParentReadable(actor, version.document_id);
    const selectionId = crypto.randomUUID();
    await tx.query(
      `INSERT INTO public.commercial_general_terms_selections(id,entity_type,entity_id,revision,document_id,version_id,snapshot,reason,created_by,idempotency_key,request_hash)
      VALUES($1::uuid,$2,$3,$4,$5::uuid,$6::uuid,$7::jsonb,$8,$9,$10::uuid,$11)`,
      [
        selectionId,
        scope,
        entityId,
        (current?.revision ?? 0) + 1,
        version.document_id,
        version.version_id,
        JSON.stringify(version),
        input.reason,
        actor,
        input.idempotency_key,
        hash,
      ],
    );
    await tx.query(
      `INSERT INTO public.ged_retention_holds(document_id,hold_type,reason,placed_by)
      VALUES($1::uuid,'LEGAL',$2,$3)`,
      [version.document_id, `Commercial terms selection ${selectionId}`, actor],
    );
    await touchTermsParent(tx, scope, entityId);
    await repoLogAccess(tx, {
      document_id: version.document_id,
      version_id: version.version_id,
      event_type: "GENERAL_TERMS_SELECTED",
      actor_id: actor,
      details: {
        entity_type: scope,
        entity_id: entityId,
        selection_id: selectionId,
        sha256: version.sha256,
        reason: input.reason,
      },
    });
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw new HttpError(
        409,
        "GENERAL_TERMS_SELECTION_CONFLICT",
        "Cette sélection a déjà été enregistrée. Actualisez le dossier.",
      );
    }
    throw error;
  } finally {
    tx.release();
  }
  return getGeneralTerms(scope, entityId, actor);
}

/** Caller first authorizes the exact business archive. Template parent ACL is
 * intentionally not reused: the issued pack belongs to its receiving dossier. */
export async function readArchivedGeneralTerms(params: {
  scope: CommercialTermsScope;
  entityId: string;
  archiveId: string;
  documentKind: string;
  actor: number;
}) {
  const archive = await repoGetAuthoritativePdf(
    pool,
    params.scope,
    params.entityId,
    params.archiveId,
    params.documentKind,
  );
  if (!archive || archive.state !== "ARCHIVED")
    throw new HttpError(
      404,
      "OFFICIAL_DOCUMENT_NOT_FOUND",
      "Document officiel introuvable.",
    );
  const value = archive.sourceSnapshot.general_terms;
  if (value == null) return null;
  const terms = generalTermsSnapshotSchema.parse(value);
  const ref = await repoInternalGetVersionContentRef(terms.version_id);
  if (
    !ref ||
    ref.document_id !== terms.document_id ||
    ref.sha256 !== terms.sha256 ||
    ref.mime_type !== "application/pdf" ||
    ref.scan_status !== "clean" ||
    ref.quarantine_status !== "released"
  ) {
    throw new HttpError(
      409,
      "GENERAL_TERMS_ARCHIVE_INTEGRITY",
      "Les conditions archivées ne peuvent pas être restituées de manière vérifiée.",
    );
  }
  const bytes = await readBlob(ref.storage_key, terms.sha256).catch(() => {
    throw new HttpError(
      503,
      "GENERAL_TERMS_UNAVAILABLE",
      "Le document de conditions est temporairement indisponible.",
    );
  });
  if (bytes.byteLength !== terms.size_bytes)
    throw new HttpError(
      409,
      "GENERAL_TERMS_ARCHIVE_INTEGRITY",
      "Le document de conditions ne correspond pas à l’archive.",
    );
  await repoLogAccess(pool, {
    document_id: terms.document_id,
    version_id: terms.version_id,
    event_type: "GENERAL_TERMS_DOWNLOADED",
    actor_id: params.actor,
    details: {
      entity_type: params.scope,
      entity_id: params.entityId,
      archive_id: archive.id,
      sha256: terms.sha256,
    },
  });
  return { bytes, filename: terms.filename, sha256: terms.sha256 };
}
