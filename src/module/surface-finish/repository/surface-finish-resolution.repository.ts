// #210 — Résolution d'article de sous-traitance depuis une opération de gamme.
//
// Deux commandes seulement :
//   `repoPreviewOperationFinish`  — LECTURE PURE, aucune écriture, jamais.
//   `repoConfirmOperationFinish`  — UNE transaction, tout ou rien.
//
// Le fournisseur, le prix, le délai et le MOQ ne participent jamais à
// l'identité technique : ils sont lus pour information et rien d'autre.

import type { PoolClient } from "pg";

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import type { AuditContext } from "../../pieces-techniques/repository/pieces-techniques.repository";
import {
  queueStockArticleCreationSnapshotTx,
  repoCreateArticleTx,
} from "../../stock/repository/stock.repository";
import type { CreateArticleBodyDTO } from "../../stock/validators/stock.validators";
import {
  assertArticleDecisionConsistent,
  assertGammeEditable,
  assertNoIdempotencyConflict,
  assertOperationBelongsToGamme,
  assertOperationIsSubcontracting,
  assertOptimisticVersion,
  assertPreviewFresh,
  assertRevisionSelectable,
  buildCanonicalFinishSpec,
  buildGeneratedDesignation,
  computePreviewHash,
  computeSpecFingerprint,
  DEFAULT_COMMENT_TEMPLATE,
  decideReceipt,
  diffCanonicalSpecs,
  GENERATED_ARTICLE_TAXONOMY,
  GENERATION_TEMPLATE_VERSION,
  normalizeThicknessUnit,
  PURCHASE_LINE_TYPE,
  renderGeneratedComment,
  requestHash,
  roleHasSurfaceFinishCapability,
  statusIsHistoricalOnly,
  SUPPLIER_CATALOGUE_CATEGORY,
  surfaceFinishCapabilitiesFor,
  thicknessToMicrometers,
  type ArticleDecision,
  type CanonicalFinishSpec,
  type FinishScope,
  type SurfaceFinishStatus,
} from "../domain/surface-finish-policy";
import type {
  ConfirmFinishBodyDTO,
  DetachFinishBodyDTO,
  OperationOverridesDTO,
  PreviewFinishBodyDTO,
  StockArticleFinishConfirmBodyDTO,
  StockArticleFinishPreviewBodyDTO,
} from "../validators/surface-finish.validators";
import type {
  ArticleMatch,
  ArticleNearMatch,
  ConfirmFinishResult,
  OperationFinishContext,
  OperationFinishRequirement,
  PlannedArticleClassification,
  PlannedPurchaseLine,
  QualityRequirementPreview,
  SupplierCandidate,
  SurfaceFinishPreview,
  SurfaceFinishRevisionDetail,
  StockFinishArticleResult,
} from "../types/surface-finish.types";
import { insertFinishAudit, mapRevision, revisionColumns, type RevisionRow } from "./surface-finish-library.repository";

type Queryer = Pick<PoolClient, "query">;

/* -------------------------------------------------------------------------- */
/* Contexte — lu côté serveur, jamais reconstruit depuis la requête           */
/* -------------------------------------------------------------------------- */

type ContextRow = {
  piece_technique_id: string;
  code_piece: string;
  designation_piece: string;
  piece_technique_version_id: string;
  indice: string;
  plan_reference: string | null;
  gamme_id: string;
  gamme_code: string | null;
  gamme_nom: string | null;
  gamme_statut: string;
  gamme_updated_at: string;
  operation_id: string;
  numero_operation: number | null;
  designation_operation: string;
  type_operation: string | null;
  operation_updated_at: string | null;
  operation_gamme_id: string | null;
};

/**
 * Anti-IDOR : la gamme, l'opération, la version et la pièce sont recoupées en
 * UNE requête. Une opération d'une autre gamme, ou une gamme d'une autre
 * version, ne peut pas franchir cette porte.
 */
async function loadContext(tx: Queryer, gammeId: string, operationId: string): Promise<OperationFinishContext> {
  const res = await tx.query<ContextRow>(
    `SELECT
       pt.id::text                 AS piece_technique_id,
       pt.code_piece               AS code_piece,
       pt.designation              AS designation_piece,
       ptv.id::text                AS piece_technique_version_id,
       ptv.indice                  AS indice,
       ptv.plan_reference          AS plan_reference,
       g.id::text                  AS gamme_id,
       g.code                      AS gamme_code,
       g.nom                       AS gamme_nom,
       g.statut                    AS gamme_statut,
       g.updated_at::text          AS gamme_updated_at,
       o.id::text                  AS operation_id,
       o.phase                     AS numero_operation,
       o.designation               AS designation_operation,
       o.type_operation            AS type_operation,
       o.updated_at::text          AS operation_updated_at,
       o.gamme_id::text            AS operation_gamme_id
     FROM public.gammes g
     JOIN public.piece_technique_versions ptv ON ptv.id = g.piece_technique_version_id
     JOIN public.pieces_techniques pt ON pt.id = ptv.piece_technique_id
     JOIN public.pieces_techniques_operations o ON o.id = $2::uuid
     WHERE g.id = $1::uuid`,
    [gammeId, operationId]
  );
  const row = res.rows[0];
  if (!row) throw new HttpError(404, "NOT_FOUND", "Gamme ou opération introuvable.");

  assertOperationBelongsToGamme(row.operation_gamme_id, gammeId);
  assertOperationIsSubcontracting(row.type_operation);

  const editable = row.gamme_statut === "BROUILLON" || row.gamme_statut === "EN_VALIDATION";
  return {
    piece_technique_id: row.piece_technique_id,
    code_piece: row.code_piece,
    designation_piece: row.designation_piece,
    piece_technique_version_id: row.piece_technique_version_id,
    indice: row.indice,
    plan_reference: row.plan_reference,
    gamme_id: row.gamme_id,
    gamme_code: row.gamme_code,
    gamme_nom: row.gamme_nom,
    gamme_statut: row.gamme_statut,
    gamme_updated_at: row.gamme_updated_at,
    gamme_editable: editable,
    operation_id: row.operation_id,
    numero_operation: row.numero_operation,
    designation_operation: row.designation_operation,
    type_operation: row.type_operation,
    operation_updated_at: row.operation_updated_at,
  };
}

async function loadRevision(tx: Queryer, revisionId: string) {
  const res = await tx.query<
    RevisionRow & {
      finish_code: string;
      finish_designation: string;
      finish_family: string;
      finish_procede: string;
      family_commentaire_template: string | null;
      finish_statut: SurfaceFinishStatus;
      finish_uuid: string;
    }
  >(
    `SELECT ${revisionColumns("r")},
            f.id::text            AS finish_uuid,
            f.code                AS finish_code,
            f.designation_courte  AS finish_designation,
            f.family_code         AS finish_family,
            f.procede             AS finish_procede,
            fam.commentaire_template AS family_commentaire_template,
            f.statut              AS finish_statut
     FROM public.surface_finish_revisions r
     JOIN public.surface_finishes f ON f.id = r.finish_id
     LEFT JOIN public.surface_finish_families fam ON fam.code = f.family_code
     WHERE r.id = $1::uuid`,
    [revisionId]
  );
  const row = res.rows[0];
  if (!row) throw new HttpError(404, "NOT_FOUND", "Révision de finition introuvable.");
  return {
    revision: mapRevision(row),
    finish: {
      id: row.finish_uuid,
      code: row.finish_code,
      designation_courte: row.finish_designation,
      family_code: row.finish_family,
      family_commentaire_template: row.family_commentaire_template,
      procede: row.finish_procede,
      statut: row.finish_statut,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Héritage révision → opération                                              */
/* -------------------------------------------------------------------------- */

/** `undefined` hérite ; `null` efface explicitement ; une valeur écrase. */
function inherit<T>(override: T | null | undefined, base: T | null): T | null {
  if (override === undefined) return base;
  return override;
}

export type ResolvedSpecInput = {
  perimetre: FinishScope;
  zones: string[];
  masquages: string[];
  norme: string | null;
  classe: string | null;
  epaisseur_min: number | null;
  epaisseur_nominale: number | null;
  epaisseur_max: number | null;
  epaisseur_unite: string;
  couleur: string | null;
  teinte_ral: string | null;
  aspect: string | null;
  rugosite: string | null;
  durete: string | null;
  exigence_corrosion: string | null;
  pretraitement: string | null;
  posttraitement: string | null;
  controles: string[];
  certificat_requis: boolean;
  certificat_type: string | null;
  conditionnement: string | null;
  unite_achat: string;
  specification_client: string | null;
  specification_client_version: string | null;
  instructions: string | null;
};

/**
 * Fusionne la révision (valeurs héritées) et les écarts saisis sur l'opération.
 * Les paramètres propres à l'opération ne modifient JAMAIS la définition maître.
 */
export function resolveOperationSpec(
  revision: SurfaceFinishRevisionDetail,
  overrides: OperationOverridesDTO
): ResolvedSpecInput {
  const perimetre = overrides.perimetre ?? "PIECE_ENTIERE";
  const zones = overrides.zones.length > 0 ? overrides.zones : revision.zones_defaut;
  const masquages = overrides.masquages.length > 0 ? overrides.masquages : revision.regles_masquage;
  const controles = overrides.controles.length > 0 ? overrides.controles : revision.controles;
  const certificatRequis = overrides.certificat_requis ?? revision.certificat_requis;

  return {
    perimetre,
    zones: perimetre === "PIECE_ENTIERE" ? [] : zones,
    masquages,
    norme: inherit(overrides.norme, revision.norme),
    classe: inherit(overrides.classe, revision.classe),
    epaisseur_min: inherit(overrides.epaisseur_min, revision.epaisseur_min),
    epaisseur_nominale: inherit(overrides.epaisseur_nominale, revision.epaisseur_nominale),
    epaisseur_max: inherit(overrides.epaisseur_max, revision.epaisseur_max),
    epaisseur_unite: overrides.epaisseur_unite ?? revision.epaisseur_unite ?? "um",
    couleur: inherit(overrides.couleur, revision.couleur),
    teinte_ral: inherit(overrides.teinte_ral, revision.teinte_ral),
    aspect: inherit(overrides.aspect, revision.aspect),
    rugosite: inherit(overrides.rugosite, revision.rugosite),
    durete: inherit(overrides.durete, revision.durete),
    exigence_corrosion: inherit(overrides.exigence_corrosion, revision.exigence_corrosion),
    pretraitement: inherit(overrides.pretraitement, revision.pretraitement),
    posttraitement: inherit(overrides.posttraitement, revision.posttraitement),
    controles,
    certificat_requis: certificatRequis,
    certificat_type: certificatRequis ? inherit(overrides.certificat_type, revision.certificat_type) : null,
    conditionnement: inherit(overrides.conditionnement, revision.conditionnement_retour),
    unite_achat: overrides.unite_achat ?? revision.unite_achat ?? "PCE",
    specification_client: overrides.specification_client ?? null,
    specification_client_version: overrides.specification_client_version ?? null,
    instructions: overrides.instructions ?? null,
  };
}

function formatThicknessSentence(spec: CanonicalFinishSpec): string | null {
  const fmt = (value: number | null) => {
    if (value === null) return null;
    const rounded = Math.round(value * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(".", ",");
  };
  const min = fmt(spec.epaisseur_min_um);
  const nom = fmt(spec.epaisseur_nominale_um);
  const max = fmt(spec.epaisseur_max_um);
  if (!min && !nom && !max) return null;
  if (nom && (min || max)) return `${nom} µm (${min ?? "—"} à ${max ?? "—"} µm)`;
  if (nom) return `${nom} µm`;
  if (min && max) return `${min} à ${max} µm`;
  return `${min ?? max} µm min.`;
}

function zoneSentence(spec: CanonicalFinishSpec): string | null {
  const parts: string[] = [];
  if (spec.zones.length > 0) parts.push(`zones : ${spec.zones.join(", ")}`);
  if (spec.masquages.length > 0) parts.push(`masquage : ${spec.masquages.join(", ")}`);
  return parts.length > 0 ? parts.join(" ; ") : null;
}

const SCOPE_LABELS: Record<FinishScope, string> = {
  PIECE_ENTIERE: "Pièce entière",
  ZONES: "Zones désignées",
  AUTRE: "Périmètre particulier",
};

export type GenerationResult = {
  designation: string;
  comment: string;
  omitted_lines: string[];
  template_version: number;
};

/**
 * Rendu serveur de la désignation et du commentaire. `includeInstructions`
 * distingue le texte porté par l'ARTICLE (identité) de celui affiché sur
 * l'exigence de l'opération : les deux restent conservés séparément.
 */
export function generateTexts(params: {
  context: OperationFinishContext;
  finish: { code: string; designation_courte: string; family_commentaire_template?: string | null };
  revision: SurfaceFinishRevisionDetail;
  spec: CanonicalFinishSpec;
}): GenerationResult {
  const { context, finish, revision, spec } = params;

  const designation = buildGeneratedDesignation({
    code_piece: context.code_piece,
    indice: context.indice,
    finition_courte: finish.designation_courte,
    teinte_ral: spec.teinte_ral,
    couleur: spec.couleur,
    epaisseur_nominale_um: spec.epaisseur_nominale_um,
    epaisseur_min_um: spec.epaisseur_min_um,
    classe: spec.classe,
    perimetre: spec.perimetre,
    zones: spec.zones,
  });

  const familyTemplate = params.finish.family_commentaire_template?.trim() ?? "";
  const revisionTemplate = revision.commentaire_template ?? DEFAULT_COMMENT_TEMPLATE;
  const template = [familyTemplate, revisionTemplate].filter(Boolean).join("\n");
  const teinteAspect = [spec.teinte_ral ?? spec.couleur, spec.aspect].filter(Boolean).join(" / ") || null;

  const rendered = renderGeneratedComment(
    template,
    {
      gamme_code: context.gamme_code ?? context.gamme_nom,
      code_piece: context.code_piece,
      designation_piece: context.designation_piece,
      indice: context.indice,
      plan_reference: context.plan_reference,
      numero_operation: context.numero_operation,
      designation_operation: context.designation_operation,
      code_finition: finish.code,
      designation_finition: finish.designation_courte,
      revision_finition: revision.revision,
      norme: spec.norme,
      epaisseur: formatThicknessSentence(spec),
      teinte_aspect: teinteAspect,
      perimetre: SCOPE_LABELS[spec.perimetre],
      zones_masquages: zoneSentence(spec),
      certificat: spec.certificat_requis ? (spec.certificat_type ?? "Oui") : null,
      controles: spec.controles.length > 0 ? spec.controles.join(", ") : null,
      conditionnement: spec.conditionnement,
      instructions: spec.instructions,
    },
    revision.template_version ?? GENERATION_TEMPLATE_VERSION
  );

  return {
    designation,
    comment: rendered.text,
    omitted_lines: rendered.omitted_lines,
    template_version: rendered.template_version,
  };
}

/* -------------------------------------------------------------------------- */
/* Correspondances d'articles                                                 */
/* -------------------------------------------------------------------------- */

type ArticleMatchRow = {
  article_id: string;
  code: string;
  designation: string;
  is_active: boolean;
  status: string | null;
  spec_fingerprint: string | null;
  spec_canonical: CanonicalFinishSpec | null;
  finish_revision_id: string | null;
  piece_technique_version_id: string | null;
  created_at: string;
};

const ARTICLE_MATCH_COLS = `
  a.id::text                       AS article_id,
  a.code                           AS code,
  a.designation                    AS designation,
  a.is_active                      AS is_active,
  a.status                         AS status,
  t.spec_fingerprint               AS spec_fingerprint,
  t.spec_canonical                 AS spec_canonical,
  t.finish_revision_id::text       AS finish_revision_id,
  t.piece_technique_version_id::text AS piece_technique_version_id,
  a.created_at::text               AS created_at
`;

/**
 * Correspondance EXACTE : par empreinte, et seulement par empreinte. Jamais par
 * désignation, jamais par ILIKE, jamais par référence fournisseur.
 */
async function findExactMatch(tx: Queryer, fingerprint: string): Promise<ArticleMatchRow | null> {
  const res = await tx.query<ArticleMatchRow>(
    `SELECT ${ARTICLE_MATCH_COLS}
     FROM public.articles_traitement t
     JOIN public.articles a ON a.id = t.article_id
     WHERE t.spec_fingerprint = $1 AND t.superseded_at IS NULL
     LIMIT 1`,
    [fingerprint]
  );
  return res.rows[0] ?? null;
}

/**
 * Correspondances PROCHES : même pièce/indice ou même révision de finition,
 * empreinte différente. Elles servent à COMPARER, jamais à réutiliser
 * automatiquement.
 */
async function findNearMatches(
  tx: Queryer,
  params: { fingerprint: string; versionId: string; revisionId: string; spec: CanonicalFinishSpec }
): Promise<ArticleNearMatch[]> {
  const res = await tx.query<ArticleMatchRow>(
    `SELECT ${ARTICLE_MATCH_COLS}
     FROM public.articles_traitement t
     JOIN public.articles a ON a.id = t.article_id
     WHERE t.superseded_at IS NULL
       AND t.spec_fingerprint IS NOT NULL
       AND t.spec_fingerprint <> $1
       AND (t.piece_technique_version_id = $2::uuid OR t.finish_revision_id = $3::uuid)
     ORDER BY (t.piece_technique_version_id = $2::uuid) DESC, a.created_at DESC
     LIMIT 5`,
    [params.fingerprint, params.versionId, params.revisionId]
  );

  return res.rows.map((row) => ({
    article_id: row.article_id,
    code: row.code,
    designation: row.designation,
    is_active: row.is_active,
    status: row.status,
    spec_fingerprint: row.spec_fingerprint,
    finish_revision_id: row.finish_revision_id,
    piece_technique_version_id: row.piece_technique_version_id,
    created_at: row.created_at,
    differences: row.spec_canonical
      ? diffCanonicalSpecs(row.spec_canonical, params.spec).map((entry) => ({
          field: String(entry.field),
          existing: entry.left,
          proposed: entry.right,
        }))
      : [{ field: "spec_canonical", existing: null, proposed: params.spec }],
  }));
}

function toArticleMatch(row: ArticleMatchRow | null): ArticleMatch | null {
  if (!row) return null;
  return {
    article_id: row.article_id,
    code: row.code,
    designation: row.designation,
    is_active: row.is_active,
    status: row.status,
    spec_fingerprint: row.spec_fingerprint,
    finish_revision_id: row.finish_revision_id,
    piece_technique_version_id: row.piece_technique_version_id,
    created_at: row.created_at,
  };
}

/**
 * Fournisseurs candidats — INFORMATIF. La finition maître n'impose jamais un
 * fournisseur ; le catalogue reste la source du prix, du MOQ et du délai, et
 * aucune de ces données n'entre dans l'empreinte.
 */
async function findSupplierCandidates(tx: Queryer, articleId: string | null): Promise<SupplierCandidate[]> {
  const res = await tx.query<SupplierCandidate>(
    `SELECT DISTINCT
       f.id::text    AS fournisseur_id,
       f.nom         AS fournisseur_nom,
       f.code        AS fournisseur_code,
       c.type        AS categorie,
       h.statut      AS statut_qualification
     FROM public.fournisseur_catalogue c
     JOIN public.fournisseurs f ON f.id = c.fournisseur_id
     LEFT JOIN public.fournisseur_homologations h
       ON h.fournisseur_id = f.id AND h.is_current = true
     WHERE c.actif = true
       AND f.actif = true
       AND (c.type = $1 OR ($2::uuid IS NOT NULL AND c.article_id = $2::uuid))
     ORDER BY f.nom
     LIMIT 20`,
    [SUPPLIER_CATALOGUE_CATEGORY, articleId]
  );
  return res.rows;
}

/* -------------------------------------------------------------------------- */
/* Aperçu — LECTURE PURE                                                      */
/* -------------------------------------------------------------------------- */

function buildClassification(): PlannedArticleClassification {
  return {
    article_type: GENERATED_ARTICLE_TAXONOMY.article_type,
    article_category: GENERATED_ARTICLE_TAXONOMY.article_category,
    article_categories: [...GENERATED_ARTICLE_TAXONOMY.article_categories],
    cat_label: "Traitement de Surface",
    family_code: GENERATED_ARTICLE_TAXONOMY.default_family_code,
    stock_managed: GENERATED_ARTICLE_TAXONOMY.stock_managed,
    lot_tracking: GENERATED_ARTICLE_TAXONOMY.lot_tracking,
    // Le code réel est alloué par le serveur à la confirmation : on annonce le
    // format, jamais une valeur qui pourrait ne pas être celle attribuée.
    code_hint: `ART-${GENERATED_ARTICLE_TAXONOMY.default_family_code}-…`,
  };
}

type StockContextRow = {
  piece_technique_id: string;
  code_piece: string;
  designation_piece: string;
  piece_technique_version_id: string;
  indice: string;
  plan_reference: string | null;
  version_updated_at: string;
};

/**
 * Contexte Stock : la PT/version vient du formulaire mais son appartenance est
 * recoupée en une requête. Le reste du moteur (résolution, empreinte, textes,
 * détection exacte et idempotence) est exactement celui de #210/#380.
 */
async function loadStockContext(
  queryer: Queryer,
  pieceTechniqueId: string,
  pieceTechniqueVersionId: string
): Promise<OperationFinishContext> {
  const result = await queryer.query<StockContextRow>(
    `SELECT
       pt.id::text AS piece_technique_id,
       pt.code_piece,
       pt.designation AS designation_piece,
       ptv.id::text AS piece_technique_version_id,
       ptv.indice,
       ptv.plan_reference,
       ptv.updated_at::text AS version_updated_at
     FROM public.pieces_techniques pt
     JOIN public.piece_technique_versions ptv
       ON ptv.piece_technique_id = pt.id
     WHERE pt.id = $1::uuid
       AND ptv.id = $2::uuid`,
    [pieceTechniqueId, pieceTechniqueVersionId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new HttpError(
      422,
      "PIECE_TECHNIQUE_VERSION_MISMATCH",
      "La version sélectionnée n'appartient pas à la pièce technique."
    );
  }
  return {
    piece_technique_id: row.piece_technique_id,
    code_piece: row.code_piece,
    designation_piece: row.designation_piece,
    piece_technique_version_id: row.piece_technique_version_id,
    indice: row.indice,
    plan_reference: row.plan_reference,
    gamme_id: row.piece_technique_version_id,
    gamme_code: "STOCK",
    gamme_nom: "Création depuis Stock",
    gamme_statut: "BROUILLON",
    gamme_updated_at: row.version_updated_at,
    gamme_editable: true,
    operation_id: row.piece_technique_version_id,
    numero_operation: null,
    designation_operation: "Création d'article depuis Stock",
    type_operation: "SOUS_TRAITANCE",
    operation_updated_at: row.version_updated_at,
  };
}

export async function repoPreviewStockFinishArticle(
  body: StockArticleFinishPreviewBodyDTO,
  actor: { user_id: number; role: string | null }
): Promise<SurfaceFinishPreview> {
  const context = await loadStockContext(db, body.piece_technique_id, body.piece_technique_version_id);
  const { revision, finish } = await loadRevision(db, body.finish_revision_id);
  const resolved = resolveOperationSpec(revision, body.overrides);
  const spec = buildCanonicalFinishSpec({
    piece_technique_version_id: context.piece_technique_version_id,
    finish_revision_id: revision.id,
    ...resolved,
  });
  const fingerprint = computeSpecFingerprint(spec);
  const texts = generateTexts({ context, finish, revision, spec });
  const exactRow = await findExactMatch(db, fingerprint);
  const nearMatches = await findNearMatches(db, {
    fingerprint,
    versionId: context.piece_technique_version_id,
    revisionId: revision.id,
    spec,
  });
  const suppliers = await findSupplierCandidates(db, exactRow?.article_id ?? null);
  const warnings: Array<{ code: string; message: string }> = [];
  if (revision.statut !== "ACTIVE") {
    warnings.push({
      code: "FINISH_REVISION_INACTIVE",
      message: `La révision ${revision.revision} est ${revision.statut.toLowerCase()} : elle ne peut pas créer un article.`,
    });
  }
  if (statusIsHistoricalOnly(finish.statut)) {
    warnings.push({ code: "FINISH_HISTORICAL", message: "Cette finition est historique et ne peut plus être sélectionnée." });
  }
  if (exactRow && !exactRow.is_active) {
    warnings.push({
      code: "ARTICLE_EXACT_MATCH_INACTIVE",
      message: `L'article exact ${exactRow.code} est inactif : réactivez-le ou créez un article distinct.`,
    });
  }
  if (suppliers.length === 0) {
    warnings.push({
      code: "NO_SUPPLIER_CANDIDATE",
      message: "Aucun fournisseur de sous-traitance actif n'est encore rattaché.",
    });
  }
  const capabilities = surfaceFinishCapabilitiesFor(actor.role);
  const allowed = decisionsAllowedFor(actor.role, Boolean(exactRow), Boolean(exactRow?.is_active));
  const previewHash = computePreviewHash({
    gamme_id: context.gamme_id,
    operation_id: context.operation_id,
    spec_fingerprint: fingerprint,
    exact_match_article_id: exactRow?.article_id ?? null,
    designation: texts.designation,
    comment: texts.comment,
    gamme_updated_at: context.gamme_updated_at,
    operation_updated_at: context.operation_updated_at,
  });
  return {
    context,
    finish,
    revision,
    spec_canonical: spec,
    spec_fingerprint: fingerprint,
    generated_designation: texts.designation,
    generated_comment: texts.comment,
    omitted_comment_lines: texts.omitted_lines,
    template_version: texts.template_version,
    classification: buildClassification(),
    exact_match: toArticleMatch(exactRow),
    near_matches: nearMatches,
    purchase_line: {
      type_achat: PURCHASE_LINE_TYPE,
      quantite: 1,
      unite: spec.unite_achat,
      designation_snapshot: texts.designation,
      gamme_operation_id: context.operation_id,
      piece_technique_version_id: context.piece_technique_version_id,
      existing_line_id: null,
    },
    suppliers,
    quality: {
      certificat_requis: spec.certificat_requis,
      certificat_type: spec.certificat_type,
      controles: spec.controles,
      criteres_acceptation: revision.criteres_acceptation,
      conditionnement: spec.conditionnement,
    },
    warnings,
    capabilities,
    allowed_decisions: allowed,
    preview_hash: previewHash,
    generated_at: new Date().toISOString(),
  };
}

export async function repoConfirmStockFinishArticle(
  body: StockArticleFinishConfirmBodyDTO,
  audit: AuditContext,
  actor: { role: string | null },
  idempotencyKey: string
): Promise<StockFinishArticleResult> {
  const commandType = "surface_finish.stock_article.confirm";
  const incomingHash = requestHash(commandType, body);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const receipt = await client.query<{ request_hash: string; result: StockFinishArticleResult }>(
      `SELECT request_hash, result
       FROM public.surface_finish_command_receipts
       WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    const existingReceipt = receipt.rows[0];
    const receiptDecision = decideReceipt(existingReceipt?.request_hash, incomingHash);
    assertNoIdempotencyConflict(receiptDecision);
    if (receiptDecision === "REPLAY") {
      await client.query("ROLLBACK");
      return existingReceipt.result;
    }

    const context = await loadStockContext(client, body.piece_technique_id, body.piece_technique_version_id);
    const { revision, finish } = await loadRevision(client, body.finish_revision_id);
    assertRevisionSelectable(revision.statut);
    const resolved = resolveOperationSpec(revision, body.overrides);
    const spec = buildCanonicalFinishSpec({
      piece_technique_version_id: context.piece_technique_version_id,
      finish_revision_id: revision.id,
      ...resolved,
    });
    const fingerprint = computeSpecFingerprint(spec);
    if (fingerprint !== body.spec_fingerprint) {
      throw new HttpError(409, "PREVIEW_STALE", "La spécification a changé depuis l'aperçu.");
    }
    const texts = generateTexts({ context, finish, revision, spec });
    const exactRow = await findExactMatch(client, fingerprint);
    const currentPreviewHash = computePreviewHash({
      gamme_id: context.gamme_id,
      operation_id: context.operation_id,
      spec_fingerprint: fingerprint,
      exact_match_article_id: exactRow?.article_id ?? null,
      designation: texts.designation,
      comment: texts.comment,
      gamme_updated_at: context.gamme_updated_at,
      operation_updated_at: context.operation_updated_at,
    });
    assertPreviewFresh(body.preview_hash, currentPreviewHash);
    assertArticleDecisionConsistent({
      decision: body.decision,
      state: {
        exactMatchArticleId: exactRow?.article_id ?? null,
        exactMatchIsActive: Boolean(exactRow?.is_active),
      },
      requestedArticleId: body.article_id,
      role: actor.role,
      justification: body.justification,
    });

    let articleId: string;
    let articleCode: string;
    let articleDesignation: string;
    let articleStatus: string;
    let result: StockFinishArticleResult["result"];
    let articleCategories = [...GENERATED_ARTICLE_TAXONOMY.article_categories] as string[];
    let articleFamily: string = GENERATED_ARTICLE_TAXONOMY.default_family_code;

    if (body.decision === "REUSE" && exactRow) {
      articleId = exactRow.article_id;
      articleCode = exactRow.code;
      articleDesignation = exactRow.designation;
      articleStatus = exactRow.status ?? "VALIDE";
      result = "REUSED";
      const classification = await client.query<{
        family_code: string;
        category_codes: string[] | null;
      }>(
        `SELECT
           a.family_code,
           array_agg(acl.category_code ORDER BY acl.is_primary DESC, acl.category_code) AS category_codes
         FROM public.articles a
         LEFT JOIN public.article_category_link acl ON acl.article_id = a.id
         WHERE a.id = $1::uuid
         GROUP BY a.id`,
        [articleId]
      );
      articleFamily = classification.rows[0]?.family_code ?? articleFamily;
      articleCategories = classification.rows[0]?.category_codes ?? articleCategories;
    } else {
      const created = await repoCreateArticleTx(
        client,
        {
          designation: texts.designation,
          designation_secondary: null,
          article_type: GENERATED_ARTICLE_TAXONOMY.article_type,
          article_category: GENERATED_ARTICLE_TAXONOMY.article_category,
          article_categories: [...GENERATED_ARTICLE_TAXONOMY.article_categories],
          family_code: GENERATED_ARTICLE_TAXONOMY.default_family_code,
          stock_managed: GENERATED_ARTICLE_TAXONOMY.stock_managed,
          lot_tracking: GENERATED_ARTICLE_TAXONOMY.lot_tracking,
          is_sold: false,
          is_active: true,
          unite: spec.unite_achat,
          notes: texts.comment,
          status: "EN_DEVIS",
          projet_id: null,
          piece_technique_id: null,
        } satisfies CreateArticleBodyDTO,
        audit
      );
      articleId = created.id;
      articleCode = created.code;
      articleDesignation = texts.designation;
      articleStatus = "EN_DEVIS";
      articleCategories = created.article_categories;
      articleFamily = created.family_code;
      result = "CREATED";
      await client.query(
        `UPDATE public.articles_traitement
         SET piece_technique_id = $2::uuid,
             piece_technique_version_id = $3::uuid,
             finish_revision_id = $4::uuid,
             spec_fingerprint = $5,
             spec_canonical = $6::jsonb,
             generated_designation = $7,
             generated_comment = $8,
             template_version = $9,
             origin = 'MANUEL',
             created_by = COALESCE(created_by, $10),
             updated_at = now()
         WHERE article_id = $1::uuid`,
        [
          articleId,
          context.piece_technique_id,
          context.piece_technique_version_id,
          revision.id,
          fingerprint,
          JSON.stringify(spec),
          texts.designation,
          texts.comment,
          texts.template_version,
          audit.user_id,
        ]
      );
      await queueStockArticleCreationSnapshotTx(client, created, audit.user_id);
    }

    await insertFinishAudit(client, audit, "finitions.stock-article.confirm", "articles_traitement", articleId, {
      piece_technique_id: context.piece_technique_id,
      piece_technique_version_id: context.piece_technique_version_id,
      finish_revision_id: revision.id,
      finish_code: finish.code,
      spec_fingerprint: fingerprint,
      preview_hash: body.preview_hash,
      decision: body.decision,
      result,
      article_code: articleCode,
      generated_designation: texts.designation,
      template_version: texts.template_version,
      idempotency_key: idempotencyKey,
    });

    const payload: StockFinishArticleResult = {
      result,
      article: {
        id: articleId,
        code: articleCode,
        designation: articleDesignation,
        status: articleStatus,
        article_type: GENERATED_ARTICLE_TAXONOMY.article_type,
        article_category: GENERATED_ARTICLE_TAXONOMY.article_category,
        article_categories: articleCategories,
        family_code: articleFamily,
        stock_managed: GENERATED_ARTICLE_TAXONOMY.stock_managed,
        lot_tracking: GENERATED_ARTICLE_TAXONOMY.lot_tracking,
      },
      next_actions: [
        { key: "article", label: "Ouvrir le brouillon Article", href: `/stock/articles/${articleId}` },
        { key: "validate", label: "Valider et mettre en production", href: `/stock/articles/${articleId}` },
      ],
    };
    await client.query(
      `INSERT INTO public.surface_finish_command_receipts
         (idempotency_key, command_type, request_hash, result, user_id)
       VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [idempotencyKey, commandType, incomingHash, JSON.stringify(payload), audit.user_id]
    );
    await client.query("COMMIT");
    return payload;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if ((error as { code?: string } | null)?.code === "23505") {
      throw new HttpError(
        409,
        "ARTICLE_EXACT_MATCH_CHANGED",
        "Un article portant cette empreinte vient d'être créé : rechargez l'aperçu."
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function repoPreviewOperationFinish(
  gammeId: string,
  operationId: string,
  body: PreviewFinishBodyDTO,
  actor: { user_id: number; role: string | null }
): Promise<SurfaceFinishPreview> {
  const context = await loadContext(db, gammeId, operationId);
  const { revision, finish } = await loadRevision(db, body.finish_revision_id);

  const resolved = resolveOperationSpec(revision, body.overrides);
  const spec = buildCanonicalFinishSpec({
    piece_technique_version_id: context.piece_technique_version_id,
    finish_revision_id: revision.id,
    ...resolved,
  });
  const fingerprint = computeSpecFingerprint(spec);
  const texts = generateTexts({ context, finish, revision, spec });

  const exactRow = await findExactMatch(db, fingerprint);
  const nearMatches = await findNearMatches(db, {
    fingerprint,
    versionId: context.piece_technique_version_id,
    revisionId: revision.id,
    spec,
  });
  const suppliers = await findSupplierCandidates(db, exactRow?.article_id ?? null);

  const existingLine = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM public.pieces_techniques_achats
     WHERE gamme_operation_id = $1::uuid AND type_achat = $2`,
    [operationId, PURCHASE_LINE_TYPE]
  );

  const warnings: Array<{ code: string; message: string }> = [];
  if (!context.gamme_editable) {
    warnings.push({
      code: "GAMME_NOT_EDITABLE",
      message: `Cette gamme est ${context.gamme_statut.toLowerCase()} : créez une nouvelle gamme ou un nouvel indice pour changer sa finition.`,
    });
  }
  if (revision.statut !== "ACTIVE") {
    warnings.push({
      code: "FINISH_REVISION_INACTIVE",
      message: `La révision ${revision.revision} est ${revision.statut.toLowerCase()} : elle ne peut pas être appliquée à une gamme.`,
    });
  }
  if (statusIsHistoricalOnly(finish.statut)) {
    warnings.push({
      code: "FINISH_HISTORICAL",
      message: "Cette finition n'est plus proposée au catalogue ; elle reste lisible dans l'historique.",
    });
  }
  if (exactRow && !exactRow.is_active) {
    warnings.push({
      code: "ARTICLE_EXACT_MATCH_INACTIVE",
      message: `L'article ${exactRow.code} correspond exactement mais il est inactif : réactivez-le ou créez un article distinct.`,
    });
  }
  if (spec.certificat_requis && !spec.certificat_type) {
    warnings.push({
      code: "CERTIFICATE_TYPE_MISSING",
      message: "Un certificat est exigé sans type précisé.",
    });
  }
  if (suppliers.length === 0) {
    warnings.push({
      code: "NO_SUPPLIER_CANDIDATE",
      message: "Aucun fournisseur de sous-traitance qualifié au catalogue : l'article restera à approvisionner.",
    });
  }

  const capabilities = surfaceFinishCapabilitiesFor(actor.role);
  const allowed: string[] = [];
  if (exactRow) {
    if (exactRow.is_active) allowed.push("REUSE");
    if (capabilities.article_force_create) allowed.push("FORCE_CREATE");
  } else if (capabilities.article_resolve) {
    allowed.push("CREATE");
  }

  const previewHash = computePreviewHash({
    gamme_id: context.gamme_id,
    operation_id: context.operation_id,
    spec_fingerprint: fingerprint,
    exact_match_article_id: exactRow?.article_id ?? null,
    designation: texts.designation,
    comment: texts.comment,
    gamme_updated_at: context.gamme_updated_at,
    operation_updated_at: context.operation_updated_at,
  });

  const quality: QualityRequirementPreview = {
    certificat_requis: spec.certificat_requis,
    certificat_type: spec.certificat_type,
    controles: spec.controles,
    criteres_acceptation: revision.criteres_acceptation,
    conditionnement: spec.conditionnement,
  };

  const purchaseLine: PlannedPurchaseLine = {
    type_achat: PURCHASE_LINE_TYPE,
    quantite: body.quantite,
    unite: spec.unite_achat,
    designation_snapshot: texts.designation,
    gamme_operation_id: context.operation_id,
    piece_technique_version_id: context.piece_technique_version_id,
    existing_line_id: existingLine.rows[0]?.id ?? null,
  };

  return {
    context,
    finish,
    revision,
    spec_canonical: spec,
    spec_fingerprint: fingerprint,
    generated_designation: texts.designation,
    generated_comment: texts.comment,
    omitted_comment_lines: texts.omitted_lines,
    template_version: texts.template_version,
    classification: buildClassification(),
    exact_match: toArticleMatch(exactRow),
    near_matches: nearMatches,
    purchase_line: purchaseLine,
    suppliers,
    quality,
    warnings,
    capabilities,
    allowed_decisions: allowed,
    preview_hash: previewHash,
    generated_at: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Exigence posée sur une opération                                           */
/* -------------------------------------------------------------------------- */

const REQUIREMENT_COLS = `
  fin.id::text                        AS id,
  fin.gamme_id::text                  AS gamme_id,
  fin.gamme_operation_id::text        AS gamme_operation_id,
  fin.piece_technique_version_id::text AS piece_technique_version_id,
  fin.finish_revision_id::text        AS finish_revision_id,
  sf.id::text                         AS finish_id,
  sf.code                             AS finish_code,
  sf.designation_courte               AS finish_designation,
  r.revision                          AS revision,
  r.statut                            AS revision_statut,
  fin.perimetre                       AS perimetre,
  fin.zones                           AS zones,
  fin.masquages                       AS masquages,
  fin.instructions                    AS instructions,
  fin.spec_fingerprint                AS spec_fingerprint,
  fin.article_id::text                AS article_id,
  a.code                              AS article_code,
  a.designation                       AS article_designation,
  fin.achat_ligne_id::text            AS achat_ligne_id,
  fin.generated_designation           AS generated_designation,
  fin.generated_comment               AS generated_comment,
  fin.designation_override            AS designation_override,
  fin.comment_override                AS comment_override,
  fin.updated_at::text                AS updated_at
`;

const REQUIREMENT_FROM = `
  FROM public.gamme_operation_finitions fin
  JOIN public.surface_finish_revisions r ON r.id = fin.finish_revision_id
  JOIN public.surface_finishes sf ON sf.id = r.finish_id
  LEFT JOIN public.articles a ON a.id = fin.article_id
`;

type RequirementRow = Omit<OperationFinishRequirement, "zones" | "masquages"> & {
  zones: string[] | null;
  masquages: string[] | null;
};

function mapRequirement(row: RequirementRow): OperationFinishRequirement {
  return { ...row, zones: row.zones ?? [], masquages: row.masquages ?? [] };
}

export async function repoGetOperationFinish(
  gammeId: string,
  operationId: string
): Promise<OperationFinishRequirement | null> {
  const res = await db.query<RequirementRow>(
    `SELECT ${REQUIREMENT_COLS} ${REQUIREMENT_FROM}
     WHERE fin.gamme_id = $1::uuid AND fin.gamme_operation_id = $2::uuid`,
    [gammeId, operationId]
  );
  const row = res.rows[0];
  return row ? mapRequirement(row) : null;
}

async function readRequirement(tx: Queryer, operationId: string): Promise<OperationFinishRequirement | null> {
  const res = await tx.query<RequirementRow>(
    `SELECT ${REQUIREMENT_COLS} ${REQUIREMENT_FROM} WHERE fin.gamme_operation_id = $1::uuid`,
    [operationId]
  );
  const row = res.rows[0];
  return row ? mapRequirement(row) : null;
}

/* -------------------------------------------------------------------------- */
/* Confirmation — UNE transaction, tout ou rien                               */
/* -------------------------------------------------------------------------- */

function nextActions(articleId: string, pieceId: string, versionId: string) {
  return [
    { key: "article", label: "Ouvrir la fiche Article", href: `/stock/articles/${articleId}` },
    { key: "achats", label: "Voir la ligne d'achat", href: `/pieces-techniques/${pieceId}?tab=achats&version=${versionId}` },
    { key: "fournisseurs", label: "Ajouter un fournisseur", href: `/stock/articles/${articleId}?tab=fournisseurs` },
    { key: "gamme", label: "Revenir à la gamme", href: `/pieces-techniques/${pieceId}?tab=gammes&version=${versionId}` },
  ];
}

export async function repoConfirmOperationFinish(
  gammeId: string,
  operationId: string,
  body: ConfirmFinishBodyDTO,
  audit: AuditContext,
  actor: { role: string | null },
  idempotencyKey: string
): Promise<ConfirmFinishResult> {
  const commandType = "surface_finish.confirm";
  const incomingHash = requestHash(commandType, { gammeId, operationId, body });

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    /* 1) Idempotence — le reçu est verrouillé AVANT tout effet de bord. */
    const receipt = await client.query<{ request_hash: string; result: ConfirmFinishResult }>(
      `SELECT request_hash, result FROM public.surface_finish_command_receipts
       WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    const existing = receipt.rows[0];
    const decisionKind = decideReceipt(existing?.request_hash, incomingHash);
    assertNoIdempotencyConflict(decisionKind);
    if (decisionKind === "REPLAY") {
      await client.query("ROLLBACK");
      return existing.result;
    }

    /* 2) Contexte, appartenance, type d'opération, modifiabilité. */
    const context = await loadContext(client, gammeId, operationId);
    assertGammeEditable(context.gamme_statut);

    // Verrous : la gamme sérialise ses opérations, l'opération sérialise sa finition.
    await client.query(`SELECT 1 FROM public.gammes WHERE id = $1::uuid FOR UPDATE`, [gammeId]);
    await client.query(`SELECT 1 FROM public.pieces_techniques_operations WHERE id = $1::uuid FOR UPDATE`, [operationId]);

    assertOptimisticVersion({
      expectedUpdatedAt: body.expected_gamme_updated_at,
      currentUpdatedAt: context.gamme_updated_at,
      label: "Cette gamme",
    });
    if (context.operation_updated_at && body.expected_operation_updated_at) {
      assertOptimisticVersion({
        expectedUpdatedAt: body.expected_operation_updated_at,
        currentUpdatedAt: context.operation_updated_at,
        label: "Cette opération",
      });
    }

    /* 3) Révision active obligatoire. */
    const { revision, finish } = await loadRevision(client, body.finish_revision_id);
    assertRevisionSelectable(revision.statut);

    /* 4) Recalcul serveur de la spécification et de l'empreinte. */
    const resolved = resolveOperationSpec(revision, body.overrides);
    const spec = buildCanonicalFinishSpec({
      piece_technique_version_id: context.piece_technique_version_id,
      finish_revision_id: revision.id,
      ...resolved,
    });
    const fingerprint = computeSpecFingerprint(spec);
    if (fingerprint !== body.spec_fingerprint) {
      throw new HttpError(
        409,
        "PREVIEW_STALE",
        "La spécification a changé depuis l'aperçu : rechargez avant de confirmer."
      );
    }

    const texts = generateTexts({ context, finish, revision, spec });

    /* 5) Fraîcheur de l'aperçu — il couvre aussi l'article exact du moment. */
    const exactRow = await findExactMatch(client, fingerprint);
    const currentPreviewHash = computePreviewHash({
      gamme_id: context.gamme_id,
      operation_id: context.operation_id,
      spec_fingerprint: fingerprint,
      exact_match_article_id: exactRow?.article_id ?? null,
      designation: texts.designation,
      comment: texts.comment,
      gamme_updated_at: context.gamme_updated_at,
      operation_updated_at: context.operation_updated_at,
    });
    assertPreviewFresh(body.preview_hash, currentPreviewHash);

    /* 6) Arbitrage de la décision. */
    const decision: ArticleDecision = body.decision;
    assertArticleDecisionConsistent({
      decision,
      state: {
        exactMatchArticleId: exactRow?.article_id ?? null,
        exactMatchIsActive: Boolean(exactRow?.is_active),
      },
      requestedArticleId: body.article_id,
      role: actor.role,
      justification: body.justification,
    });

    /* 7) Article : réutilisation ou création via le service Article canonique. */
    let articleId: string;
    let articleCode: string;
    let articleDesignation: string;
    let result: ConfirmFinishResult["result"];
    let articleCategories: string[] = [...GENERATED_ARTICLE_TAXONOMY.article_categories];
    let articleFamily: string = GENERATED_ARTICLE_TAXONOMY.default_family_code;

    if (decision === "REUSE" && exactRow) {
      articleId = exactRow.article_id;
      articleCode = exactRow.code;
      articleDesignation = exactRow.designation;
      result = "REUSED";
      const cats = await client.query<{ category_code: string }>(
        `SELECT category_code FROM public.article_category_link WHERE article_id = $1::uuid ORDER BY is_primary DESC`,
        [articleId]
      );
      articleCategories = cats.rows.map((row) => row.category_code);
      const fam = await client.query<{ family_code: string }>(
        `SELECT family_code FROM public.articles WHERE id = $1::uuid`,
        [articleId]
      );
      articleFamily = fam.rows[0]?.family_code ?? articleFamily;
    } else {
      const created = await repoCreateArticleTx(
        client,
        {
          designation: texts.designation,
          designation_secondary: null,
          article_type: GENERATED_ARTICLE_TAXONOMY.article_type,
          article_category: GENERATED_ARTICLE_TAXONOMY.article_category,
          article_categories: [...GENERATED_ARTICLE_TAXONOMY.article_categories],
          family_code: GENERATED_ARTICLE_TAXONOMY.default_family_code,
          // Une prestation ne se stocke pas : la pièce traitée et ses lots
          // restent tracés par les domaines OF, sous-traitance et réception.
          stock_managed: GENERATED_ARTICLE_TAXONOMY.stock_managed,
          lot_tracking: GENERATED_ARTICLE_TAXONOMY.lot_tracking,
          is_sold: false,
          is_active: true,
          unite: spec.unite_achat,
          notes: texts.comment,
          status: "VALIDE",
          projet_id: null,
          piece_technique_id: null,
        } satisfies CreateArticleBodyDTO,
        audit
      );
      articleId = created.id;
      articleCode = created.code;
      articleDesignation = texts.designation;
      articleCategories = created.article_categories;
      articleFamily = created.family_code;
      result = "CREATED";

      // La spécialisation porte l'identité technique. L'index partiel unique
      // sur `spec_fingerprint` fait échouer ici une seconde création
      // concurrente : c'est la base qui garantit l'unicité, pas la lecture.
      await client.query(
        `UPDATE public.articles_traitement
         SET piece_technique_id = $2::uuid,
             piece_technique_version_id = $3::uuid,
             finish_revision_id = $4::uuid,
             spec_fingerprint = $5,
             spec_canonical = $6::jsonb,
             generated_designation = $7,
             generated_comment = $8,
             template_version = $9,
             origin = 'GAMME_FINITION',
             created_by = COALESCE(created_by, $10),
             updated_at = now()
         WHERE article_id = $1::uuid`,
        [
          articleId,
          context.piece_technique_id,
          context.piece_technique_version_id,
          revision.id,
          fingerprint,
          JSON.stringify(spec),
          texts.designation,
          texts.comment,
          texts.template_version,
          audit.user_id,
        ]
      );
      await queueStockArticleCreationSnapshotTx(client, created, audit.user_id);
    }

    /* 8) Exigence de finition — créée ou mise à jour, jamais dupliquée. */
    const previous = await readRequirement(client, operationId);
    if (previous && body.expected_finition_updated_at) {
      assertOptimisticVersion({
        expectedUpdatedAt: body.expected_finition_updated_at,
        currentUpdatedAt: previous.updated_at,
        label: "Cette exigence de finition",
      });
    }
    if (previous && result === "REUSED" && previous.article_id === articleId) {
      result = "LINKED";
    }

    const requirementValues = [
      context.gamme_id,
      context.operation_id,
      context.piece_technique_version_id,
      revision.id,
      spec.perimetre,
      spec.zones,
      spec.masquages,
      resolved.norme,
      resolved.classe,
      resolved.epaisseur_min,
      resolved.epaisseur_nominale,
      resolved.epaisseur_max,
      normalizeThicknessUnit(resolved.epaisseur_unite),
      resolved.couleur,
      resolved.teinte_ral,
      resolved.aspect,
      resolved.rugosite,
      resolved.durete,
      resolved.exigence_corrosion,
      resolved.pretraitement,
      resolved.posttraitement,
      spec.controles,
      spec.certificat_requis,
      spec.certificat_type,
      resolved.conditionnement,
      spec.unite_achat,
      resolved.specification_client,
      resolved.specification_client_version,
      resolved.instructions,
      JSON.stringify(spec),
      fingerprint,
      articleId,
      texts.designation,
      texts.comment,
      texts.template_version,
      audit.user_id,
    ];

    await client.query(
      `INSERT INTO public.gamme_operation_finitions (
         gamme_id, gamme_operation_id, piece_technique_version_id, finish_revision_id,
         perimetre, zones, masquages,
         norme, classe, epaisseur_min, epaisseur_nominale, epaisseur_max, epaisseur_unite,
         couleur, teinte_ral, aspect, rugosite, durete, exigence_corrosion,
         pretraitement, posttraitement,
         controles, certificat_requis, certificat_type, conditionnement, unite_achat,
         specification_client, specification_client_version, instructions,
         spec_canonical, spec_fingerprint, article_id,
         generated_designation, generated_comment, template_version,
         created_by, updated_by
       ) VALUES (
         $1::uuid,$2::uuid,$3::uuid,$4::uuid,
         $5,$6,$7,
         $8,$9,$10,$11,$12,$13,
         $14,$15,$16,$17,$18,$19,
         $20,$21,
         $22,$23,$24,$25,$26,
         $27,$28,$29,
         $30::jsonb,$31,$32::uuid,
         $33,$34,$35,
         $36,$36
       )
       ON CONFLICT (gamme_operation_id) DO UPDATE SET
         gamme_id = EXCLUDED.gamme_id,
         piece_technique_version_id = EXCLUDED.piece_technique_version_id,
         finish_revision_id = EXCLUDED.finish_revision_id,
         perimetre = EXCLUDED.perimetre,
         zones = EXCLUDED.zones,
         masquages = EXCLUDED.masquages,
         norme = EXCLUDED.norme,
         classe = EXCLUDED.classe,
         epaisseur_min = EXCLUDED.epaisseur_min,
         epaisseur_nominale = EXCLUDED.epaisseur_nominale,
         epaisseur_max = EXCLUDED.epaisseur_max,
         epaisseur_unite = EXCLUDED.epaisseur_unite,
         couleur = EXCLUDED.couleur,
         teinte_ral = EXCLUDED.teinte_ral,
         aspect = EXCLUDED.aspect,
         rugosite = EXCLUDED.rugosite,
         durete = EXCLUDED.durete,
         exigence_corrosion = EXCLUDED.exigence_corrosion,
         pretraitement = EXCLUDED.pretraitement,
         posttraitement = EXCLUDED.posttraitement,
         controles = EXCLUDED.controles,
         certificat_requis = EXCLUDED.certificat_requis,
         certificat_type = EXCLUDED.certificat_type,
         conditionnement = EXCLUDED.conditionnement,
         unite_achat = EXCLUDED.unite_achat,
         specification_client = EXCLUDED.specification_client,
         specification_client_version = EXCLUDED.specification_client_version,
         instructions = EXCLUDED.instructions,
         spec_canonical = EXCLUDED.spec_canonical,
         spec_fingerprint = EXCLUDED.spec_fingerprint,
         article_id = EXCLUDED.article_id,
         generated_designation = EXCLUDED.generated_designation,
         generated_comment = EXCLUDED.generated_comment,
         template_version = EXCLUDED.template_version,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      requirementValues
    );

    /* 9) Ligne de nomenclature d'achat — liée par FK, jamais par la phase. */
    const lineRes = await client.query<{ id: string; quantite: string }>(
      `INSERT INTO public.pieces_techniques_achats (
         piece_technique_id, phase, article_id, quantite, unite_prix,
         designation, designation_snapshot, type_achat,
         gamme_operation_id, gamme_id, piece_technique_version_id, source
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4, $5,
         $6, $6, $7,
         $8::uuid, $9::uuid, $10::uuid, 'GAMME_FINITION'
       )
       ON CONFLICT (gamme_operation_id) WHERE gamme_operation_id IS NOT NULL AND type_achat = 'TRAITEMENT'
       DO UPDATE SET
         article_id = EXCLUDED.article_id,
         quantite = EXCLUDED.quantite,
         unite_prix = EXCLUDED.unite_prix,
         designation = EXCLUDED.designation,
         designation_snapshot = EXCLUDED.designation_snapshot,
         gamme_id = EXCLUDED.gamme_id,
         piece_technique_version_id = EXCLUDED.piece_technique_version_id,
         phase = EXCLUDED.phase,
         updated_at = now()
       RETURNING id::text AS id, quantite::text AS quantite`,
      [
        context.piece_technique_id,
        context.numero_operation,
        articleId,
        body.quantite,
        spec.unite_achat,
        texts.designation,
        PURCHASE_LINE_TYPE,
        context.operation_id,
        context.gamme_id,
        context.piece_technique_version_id,
      ]
    );
    const purchaseLineId = lineRes.rows[0].id;

    await client.query(
      `UPDATE public.gamme_operation_finitions SET achat_ligne_id = $2::uuid, updated_at = now()
       WHERE gamme_operation_id = $1::uuid`,
      [operationId, purchaseLineId]
    );

    /* 10) Audit append-only — la décision reste explicable des mois plus tard. */
    await insertFinishAudit(client, audit, "finitions.operation.confirm", "gamme_operation_finition", operationId, {
      gamme_id: context.gamme_id,
      piece_technique_version_id: context.piece_technique_version_id,
      finish_revision_id: revision.id,
      finish_code: finish.code,
      spec_fingerprint: fingerprint,
      preview_hash: body.preview_hash,
      decision,
      result,
      article_id: articleId,
      article_code: articleCode,
      exact_match_article_id: exactRow?.article_id ?? null,
      justification: decision === "FORCE_CREATE" ? body.justification : null,
      generated_designation: texts.designation,
      template_version: texts.template_version,
      achat_ligne_id: purchaseLineId,
      idempotency_key: idempotencyKey,
    });

    const requirement = await readRequirement(client, operationId);
    if (!requirement) throw new Error("Failed to read finish requirement after write");

    const payload: ConfirmFinishResult = {
      result,
      article: {
        id: articleId,
        code: articleCode,
        designation: articleDesignation,
        article_type: GENERATED_ARTICLE_TAXONOMY.article_type,
        article_category: GENERATED_ARTICLE_TAXONOMY.article_category,
        article_categories: articleCategories,
        family_code: articleFamily,
        stock_managed: GENERATED_ARTICLE_TAXONOMY.stock_managed,
        lot_tracking: GENERATED_ARTICLE_TAXONOMY.lot_tracking,
      },
      requirement,
      purchase_line: {
        id: purchaseLineId,
        type_achat: PURCHASE_LINE_TYPE,
        quantite: Number(lineRes.rows[0].quantite),
        designation_snapshot: texts.designation,
      },
      next_actions: nextActions(articleId, context.piece_technique_id, context.piece_technique_version_id),
    };

    await client.query(
      `INSERT INTO public.surface_finish_command_receipts (idempotency_key, command_type, request_hash, result, user_id)
       VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [idempotencyKey, commandType, incomingHash, JSON.stringify(payload), audit.user_id]
    );

    await client.query("COMMIT");
    return payload;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // Deux confirmations réellement concurrentes : la seconde perd la course sur
    // l'index d'unicité. On la renvoie vers l'aperçu plutôt que vers un 500.
    if ((err as { code?: string } | null)?.code === "23505") {
      throw new HttpError(
        409,
        "ARTICLE_EXACT_MATCH_CHANGED",
        "Un article portant cette empreinte vient d'être créé : rechargez l'aperçu pour le réutiliser."
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------------------- */
/* Retrait de l'exigence                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Retire l'exigence d'une opération. L'ARTICLE et la ligne d'achat ne sont
 * jamais supprimés en silence : la ligne est détachée de l'opération et
 * conservée, l'article reste au référentiel.
 */
export async function repoDetachOperationFinish(
  gammeId: string,
  operationId: string,
  body: DetachFinishBodyDTO,
  audit: AuditContext
): Promise<{ detached: true }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const context = await loadContext(client, gammeId, operationId);
    assertGammeEditable(context.gamme_statut);

    const current = await client.query<{ id: string; updated_at: string; article_id: string | null; achat_ligne_id: string | null }>(
      `SELECT id::text AS id, updated_at::text AS updated_at, article_id::text AS article_id,
              achat_ligne_id::text AS achat_ligne_id
       FROM public.gamme_operation_finitions
       WHERE gamme_operation_id = $1::uuid FOR UPDATE`,
      [operationId]
    );
    const row = current.rows[0];
    if (!row) throw new HttpError(404, "NOT_FOUND", "Aucune finition configurée sur cette opération.");
    assertOptimisticVersion({
      expectedUpdatedAt: body.expected_updated_at,
      currentUpdatedAt: row.updated_at,
      label: "Cette exigence de finition",
    });

    if (row.achat_ligne_id) {
      await client.query(
        `UPDATE public.pieces_techniques_achats
         SET gamme_operation_id = NULL, source = 'MANUEL', updated_at = now()
         WHERE id = $1::uuid`,
        [row.achat_ligne_id]
      );
    }
    await client.query(`DELETE FROM public.gamme_operation_finitions WHERE gamme_operation_id = $1::uuid`, [operationId]);

    await insertFinishAudit(client, audit, "finitions.operation.detach", "gamme_operation_finition", operationId, {
      gamme_id: gammeId,
      motif: body.motif,
      article_id: row.article_id,
      achat_ligne_id: row.achat_ligne_id,
      // L'article et la ligne d'achat SURVIVENT : rien n'est supprimé ici.
      article_deleted: false,
      purchase_line_deleted: false,
    });

    await client.query("COMMIT");
    return { detached: true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Exposé pour les tests de politique : la capacité conditionne les décisions. */
export function decisionsAllowedFor(role: string | null, hasExactMatch: boolean, exactIsActive: boolean): string[] {
  const out: string[] = [];
  if (hasExactMatch) {
    if (exactIsActive) out.push("REUSE");
    if (roleHasSurfaceFinishCapability(role, "article_force_create")) out.push("FORCE_CREATE");
  } else if (roleHasSurfaceFinishCapability(role, "article_resolve")) {
    out.push("CREATE");
  }
  return out;
}

export { thicknessToMicrometers };
