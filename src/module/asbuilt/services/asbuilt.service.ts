import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import pool from "../../../config/database"
import { ensureDocumentStoragePath, getTmpRootPath } from "../../../utils/cerpStorage"
import { HttpError } from "../../../utils/httpError"

import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository"
import { roleHasTraceabilityCapability } from "../../traceability/domain/traceability-policy"

import type { AsbuiltGenerateBodyDTO } from "../validators/asbuilt.validators"
import type { AsBuiltGenerateResult, AsBuiltPreview } from "../types/asbuilt.types"

import {
  buildAsbuiltFileName,
  repoAllocateAsbuiltVersionTx,
  repoCountNcForLot,
  repoFindAsbuiltDocumentFilePath,
  repoGetLotHeader,
  repoGetUserLabel,
  repoInsertAsbuiltPackVersionTx,
  repoInsertDocumentsClientTx,
  repoIsAsbuiltDocumentLinked,
  repoListBonLivraisonsForLot,
  repoListNonConformitiesForLot,
  repoListOfsForLot,
  repoListPackVersions,
} from "../repository/asbuilt.repository"
import {
  computeAsbuiltCoverage,
  repoLoadAsbuiltEnrichment,
} from "../repository/asbuilt-enrichment.repository"

import { svcRenderAsbuiltPdf } from "./asbuilt-pdf.service"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getPgErrorInfo(err: unknown) {
  if (!isRecord(err)) return { code: null as string | null, constraint: null as string | null }
  const code = typeof err.code === "string" ? err.code : null
  const constraint = typeof err.constraint === "string" ? err.constraint : null
  return { code, constraint }
}

async function ensureDocsDir(): Promise<string> {
  const baseDir = ensureDocumentStoragePath("asbuilt")
  await fs.mkdir(baseDir, { recursive: true })
  return baseDir
}

/**
 * Zone de PRÉPARATION, distincte de la zone documentaire. Rien n'atterrit dans
 * l'espace des documents avant d'avoir été écrit, mesuré, haché ET validé en
 * base : c'est ce qui empêche un fichier orphelin (écrit puis transaction en
 * échec) ou, pire, un enregistrement pointant vers un fichier absent.
 */
async function ensureStagingDir(): Promise<string> {
  const dir = getTmpRootPath("asbuilt-staging")
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function sha256Of(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex")
}

function buildSummaryJson(
  preview: AsBuiltPreview,
  args: {
    version: number
    generated_by: number
    signataire_user_id: number
    commentaire: string | null
    pdf_document_id: string
    pdf_sha256: string
    as_of: string
  }
) {
  return {
    asbuilt: {
      version: args.version,
      generated_by: args.generated_by,
      signataire_user_id: args.signataire_user_id,
      commentaire: args.commentaire,
      pdf_document_id: args.pdf_document_id,
      pdf_sha256: args.pdf_sha256,
      as_of: args.as_of,
    },
    lot: {
      id: preview.lot.id,
      lot_code: preview.lot.lot_code,
      article_id: preview.lot.article_id,
      article_code: preview.lot.article_code,
      article_designation: preview.lot.article_designation,
      lot_status: preview.enrichment?.lot_status.current ?? null,
    },
    links: {
      of_ids: preview.ofs.map((o) => o.id),
      bon_livraison_ids: preview.bon_livraisons.map((b) => b.id),
      non_conformity_ids: preview.non_conformities.map((n) => n.id),
      consumed_lot_ids: (preview.enrichment?.consumed_lots ?? []).map((c) => c.lot_id),
      control_ids: (preview.enrichment?.controls ?? []).map((c) => c.control_id),
      instrument_ids: Array.from(
        new Set(
          (preview.enrichment?.measurements ?? [])
            .map((m) => m.instrument_id)
            .filter((id): id is string => Boolean(id))
        )
      ),
    },
    evidence_hashes: {
      technical_snapshots: (preview.enrichment?.technical_versions ?? [])
        .map((v) => ({ of_numero: v.of_numero, sha256: v.snapshot_sha256 }))
        .filter((v) => v.sha256),
      control_plans: (preview.enrichment?.controls ?? [])
        .map((c) => ({ reference: c.reference, sha256: c.plan_snapshot_sha256 }))
        .filter((c) => c.sha256),
    },
    checks: preview.checks,
    coverage_warnings: preview.coverage_warnings ?? [],
  }
}

/* -------------------------------------------------------------------------- */
/* Aperçu                                                                     */
/* -------------------------------------------------------------------------- */

export async function svcGetAsbuiltPreview(
  lotId: string,
  options: { role?: string | null } = {}
): Promise<AsBuiltPreview> {
  const lot = await repoGetLotHeader(lotId)
  if (!lot) throw new HttpError(404, "LOT_NOT_FOUND", "Lot introuvable")

  const [ofs, bonLivraisons, ncs, packVersions, ncCounts] = await Promise.all([
    repoListOfsForLot(lotId),
    repoListBonLivraisonsForLot(lotId),
    repoListNonConformitiesForLot(lotId),
    repoListPackVersions(lotId),
    repoCountNcForLot(lotId),
  ])

  // RGPD : sans le droit de lire une donnée personnelle, le dossier reste
  // complet et vérifiable, mais les opérateurs y sont pseudonymisés.
  const canReadPersonalData = roleHasTraceabilityCapability(
    options.role ?? null,
    "personal_data_read"
  )

  const enrichment = await repoLoadAsbuiltEnrichment({
    lotId,
    ofIds: ofs.map((o) => o.id),
    blIds: bonLivraisons.map((b) => b.id),
    canReadPersonalData,
  })

  const checks = {
    open_non_conformities: ncCounts.open,
    overdue_non_conformities: ncCounts.overdue,
    has_of_link: ofs.length > 0,
    has_shipping_link: bonLivraisons.length > 0,
  }

  return {
    lot,
    ofs,
    bon_livraisons: bonLivraisons,
    non_conformities: ncs,
    pack_versions: packVersions,
    checks,
    enrichment,
    coverage_warnings: computeAsbuiltCoverage(enrichment, {
      hasOf: checks.has_of_link,
      hasShipping: checks.has_shipping_link,
      openNc: checks.open_non_conformities,
    }),
    personal_data_masked: !canReadPersonalData,
  }
}

/* -------------------------------------------------------------------------- */
/* Génération                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Génération d'une version du dossier as-built.
 *
 * Séquence durcie (#142) :
 *   1. rendu du PDF en zone de PRÉPARATION (jamais dans l'espace documentaire) ;
 *   2. calcul de l'empreinte SHA-256 et de la taille réelles du fichier écrit ;
 *   3. transaction : allocation du numéro de version SOUS VERROU, insertion du
 *      document et de la version avec l'empreinte, journal d'audit ;
 *   4. promotion du fichier vers l'espace documentaire APRÈS le COMMIT ;
 *   5. en cas d'échec à n'importe quelle étape, nettoyage de la préparation.
 *
 * Conséquences : aucun enregistrement ne peut pointer vers un fichier absent,
 * aucun fichier ne peut rester orphelin silencieusement, et deux générations
 * concurrentes du même lot ne peuvent pas se voir attribuer le même numéro.
 */
export async function svcGenerateAsbuiltPack(params: {
  lotId: string
  actorUserId: number
  body: AsbuiltGenerateBodyDTO
  role?: string | null
}): Promise<AsBuiltGenerateResult> {
  const preview = await svcGetAsbuiltPreview(params.lotId, { role: params.role })

  const signataireUserId = params.body.signataire_user_id ?? params.actorUserId
  const signataireLabel = await repoGetUserLabel(signataireUserId)
  const commentaire = params.body.commentaire?.trim() ? params.body.commentaire.trim() : null

  const stagingDir = await ensureStagingDir()
  const docsDir = await ensureDocsDir()

  let attempt = 0
  let lastConflict: unknown = null

  while (attempt < 3) {
    attempt += 1

    const pdfDocumentId = crypto.randomUUID()
    const stagingPath = path.join(stagingDir, `${pdfDocumentId}.pdf.part`)
    const finalPath = path.join(docsDir, `${pdfDocumentId}.pdf`)
    const generatedAt = new Date()
    const asOf = generatedAt.toISOString()

    let promoted = false

    try {
      // ── 1) Rendu en zone de préparation ────────────────────────────────
      // Le numéro de version définitif n'est connu qu'après l'allocation sous
      // verrou : on rend d'abord un PDF avec la version PRESSENTIE, puis on la
      // confirme dans la transaction. Si elle diffère, on recommence — c'est
      // moins coûteux que de tenir un verrou pendant tout le rendu PDF.
      const expectedVersion = await peekNextVersion(params.lotId)
      const pdfBuffer = await svcRenderAsbuiltPdf({
        preview,
        version: expectedVersion,
        generatedAt,
        signataireLabel,
        commentaire,
      })
      await fs.writeFile(stagingPath, pdfBuffer)

      // ── 2) Empreinte et taille du fichier RÉELLEMENT écrit ─────────────
      const written = await fs.readFile(stagingPath)
      const pdfSha256 = sha256Of(written)
      const pdfSizeBytes = written.byteLength

      // ── 3) Transaction ─────────────────────────────────────────────────
      const tx = await pool.connect()
      let committed = false
      let version = expectedVersion
      let asbuiltVersionId = ""

      try {
        await tx.query("BEGIN")

        version = await repoAllocateAsbuiltVersionTx(tx, params.lotId)
        if (version !== expectedVersion) {
          // Une autre génération a pris le numéro pendant le rendu : on relâche
          // le verrou et on recommence avec le bon numéro plutôt que d'écrire
          // un PDF dont l'en-tête mentirait sur sa propre version.
          await tx.query("ROLLBACK")
          throw new VersionRaceError(version)
        }

        const fileName = buildAsbuiltFileName({ lot_code: preview.lot.lot_code, version })

        await repoInsertDocumentsClientTx(tx, {
          documentId: pdfDocumentId,
          documentName: fileName,
          type: "PDF",
        })

        const summaryJson = buildSummaryJson(preview, {
          version,
          generated_by: params.actorUserId,
          signataire_user_id: signataireUserId,
          commentaire,
          pdf_document_id: pdfDocumentId,
          pdf_sha256: pdfSha256,
          as_of: asOf,
        })

        asbuiltVersionId = await repoInsertAsbuiltPackVersionTx(tx, {
          lotId: params.lotId,
          version,
          actorUserId: params.actorUserId,
          signataireUserId,
          commentaire,
          pdfDocumentId,
          summaryJson,
          pdfSha256,
          pdfSizeBytes,
          asOf,
          scopeJson: {
            as_of: asOf,
            of_ids: preview.ofs.map((o) => o.id),
            bon_livraison_ids: preview.bon_livraisons.map((b) => b.id),
            personal_data_masked: preview.personal_data_masked ?? false,
            coverage_warning_codes: (preview.coverage_warnings ?? []).map((w) => w.code),
          },
        })

        await repoInsertAuditLog({
          user_id: params.actorUserId,
          body: {
            event_type: "ACTION",
            action: "asbuilt.pack.generated",
            page_key: "traceabilite",
            entity_type: "lots",
            entity_id: params.lotId,
            path: `/api/v1/asbuilt/lots/${params.lotId}/generate`,
            client_session_id: null,
            details: {
              lot_code: preview.lot.lot_code,
              version,
              asbuilt_version_id: asbuiltVersionId,
              pdf_document_id: pdfDocumentId,
              pdf_sha256: pdfSha256,
              coverage_warnings: (preview.coverage_warnings ?? []).length,
            },
          },
          ip: null,
          user_agent: null,
          device_type: null,
          os: null,
          browser: null,
          tx,
        })

        await tx.query("COMMIT")
        committed = true
      } catch (err) {
        if (!committed) await tx.query("ROLLBACK").catch(() => undefined)
        throw err
      } finally {
        tx.release()
      }

      // ── 4) Promotion APRÈS validation en base ──────────────────────────
      await fs.rename(stagingPath, finalPath)
      promoted = true

      return { asbuilt_version_id: asbuiltVersionId, version, pdf_document_id: pdfDocumentId }
    } catch (err) {
      // ── 5) Nettoyage : ni fichier orphelin, ni préparation résiduelle ──
      await fs.unlink(stagingPath).catch(() => undefined)
      if (promoted) await fs.unlink(finalPath).catch(() => undefined)

      if (err instanceof VersionRaceError) {
        lastConflict = err
        continue
      }

      const pg = getPgErrorInfo(err)
      if (
        pg.code === "23505" &&
        (pg.constraint ?? "").includes("asbuilt_pack_versions_lot_version_uniq")
      ) {
        lastConflict = err
        continue
      }
      throw err
    }
  }

  throw new HttpError(
    409,
    "ASBUILT_VERSION_CONFLICT",
    "Une autre génération du dossier a abouti pendant celle-ci. Rechargez la fiche et réessayez.",
    { attempts: attempt, last_conflict: lastConflict instanceof Error ? lastConflict.message : null }
  )
}

class VersionRaceError extends Error {
  constructor(public readonly actualVersion: number) {
    super(`asbuilt version race: expected a different version, got ${actualVersion}`)
    this.name = "VersionRaceError"
  }
}

async function peekNextVersion(lotId: string): Promise<number> {
  const res = await pool.query<{ version: string | number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS version
       FROM public.asbuilt_pack_versions
      WHERE lot_fg_id = $1::uuid`,
    [lotId]
  )
  const raw = res.rows[0]?.version
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN
  return Number.isInteger(n) && n > 0 ? n : 1
}

/* -------------------------------------------------------------------------- */
/* Téléchargement                                                             */
/* -------------------------------------------------------------------------- */

export async function svcResolveAsbuiltDocument(params: {
  lotId: string
  documentId: string
}): Promise<{ filePath: string; name: string }> {
  // Anti-IDOR : le document doit appartenir À CE lot. Connaître l'identifiant
  // d'un document ne suffit pas à le télécharger.
  const linked = await repoIsAsbuiltDocumentLinked(params.lotId, params.documentId)
  if (!linked) throw new HttpError(404, "DOCUMENT_NOT_FOUND", "Document introuvable")

  const filePath = await repoFindAsbuiltDocumentFilePath(params.documentId)
  if (!filePath) throw new HttpError(404, "FILE_NOT_FOUND", "Fichier introuvable")

  const name = path.basename(filePath)
  return { filePath, name }
}
