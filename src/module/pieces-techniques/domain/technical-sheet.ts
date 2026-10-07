import { HttpError } from "../../../utils/httpError";
import { buildInternalCreationSnapshot } from "../../../shared/authoritative-documents/internal-creation-snapshot";

type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const list = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map(row) : [];
const value = (input: unknown): string | null =>
  input == null ? null : String(input).trim() || null;
const joined = (...parts: unknown[]) =>
  parts.map(value).filter(Boolean).join(" — ") || null;

/** Whitelisted technical data only: supplier prices and hourly rates are excluded. */
export function buildTechnicalSheet(source: unknown) {
  const data = row(source),
    piece = row(data.piece),
    version = row(data.version),
    gamme = row(data.gamme);
  const operations = list(data.operations),
    bom = list(data.nomenclature),
    achats = list(data.achats);
  const requirements = list(data.requirements),
    documents = list(data.documents);
  const instructions = operations
    .filter((op) => value(op.consignes))
    .map((op) => `PHASE ${value(op.phase) ?? "—"}\n${value(op.consignes)}`)
    .join("\n\n");
  const instructionSections = Array.from(
    { length: Math.ceil(instructions.length / 18000) },
    (_, index) => ({
      title: `Consignes de fabrication${index ? ` — suite ${index + 1}` : ""}`,
      notes: instructions.slice(index * 18000, (index + 1) * 18000),
    }),
  );
  if (
    [operations, bom, achats, requirements, documents].some(
      (items) => items.length > 250,
    ) ||
    instructionSections.length > 18
  ) {
    throw new HttpError(
      422,
      "TECHNICAL_SHEET_TOO_LARGE",
      "La fiche dépasse le format d’édition : 250 lignes par rubrique ou un volume de consignes trop important. Utilisez le dossier détaillé.",
    );
  }
  const reference = value(version.code_metier) ?? value(piece.code);
  if (!reference || !value(piece.designation) || !value(version.id))
    throw new HttpError(
      422,
      "TECHNICAL_SHEET_SOURCE_INVALID",
      "La définition technique est incomplète.",
    );
  return buildInternalCreationSnapshot({
    entityLabel: value(piece.designation)!,
    reference,
    summary: [
      { label: "Référence plan", value: version.plan_reference },
      { label: "Indice client", value: version.indice },
      { label: "Version interne", value: version.version_interne },
      { label: "Statut technique", value: version.statut },
      { label: "Client", value: joined(piece.client_code, piece.client_name) },
      { label: "Pièce critique", value: piece.critical ? "Oui" : "Non" },
    ],
    sections: [
      {
        title: "Définition de la pièce",
        rows: [
          { label: "Version technique (UUID)", value: version.id },
          { label: "Désignation complémentaire", value: piece.designation_2 },
          { label: "Mode de fabrication", value: version.manufacturing_mode },
          { label: "Matière prévue", value: version.matiere_prevue },
          {
            label: "Changement",
            value: joined(version.change_level, version.type_changement),
          },
          { label: "Raison du changement", value: version.raison_changement },
          {
            label: "Commentaire de révision",
            value: version.commentaire_revision,
          },
          { label: "Date d’effet", value: version.date_effet },
          { label: "Validation", value: version.date_validation },
          {
            label: "Gamme",
            value: joined(gamme.code, gamme.designation, gamme.statut),
          },
          {
            label: "Conditionnement",
            value: joined(
              row(version.packaging_policy).mode,
              row(version.packaging_policy).lotSize,
            ),
          },
          {
            label: "Exigences qualité",
            value: Array.isArray(piece.quality_levels)
              ? piece.quality_levels.join(", ")
              : null,
          },
        ],
      },
      {
        title: "Gamme de fabrication — temps en heures décimales",
        table: {
          columns: [
            { key: "phase", label: "Phase" },
            { key: "op", label: "Opération" },
            { key: "centre", label: "Centre" },
            { key: "machine", label: "Machine / famille" },
            { key: "programme", label: "Programme" },
            { key: "tr", label: "TR (h)" },
            { key: "tp", label: "T/P (h/pièce)" },
            { key: "base", label: "Qté de base" },
          ],
          rows: operations.map((op) => ({
            phase: op.phase,
            op: joined(op.type, op.designation),
            centre: op.centre,
            machine: joined(op.machine, op.family),
            programme: op.programme,
            tr: op.reglage_h,
            tp: op.piece_h,
            base: op.base_qty,
          })),
        },
      },
      ...instructionSections,
      {
        title: "Nomenclature d’assemblage",
        table: {
          columns: [
            { key: "repere", label: "Repère" },
            { key: "ref", label: "Référence" },
            { key: "designation", label: "Désignation" },
            { key: "indice", label: "Indice / version" },
            { key: "qty", label: "Qté / ensemble" },
            { key: "scope", label: "Source" },
          ],
          rows: bom.map((n) => ({
            repere: n.repere,
            ref: n.reference,
            designation: n.designation,
            indice: joined(n.indice, n.version),
            qty: n.qty,
            scope: n.scope,
          })),
        },
      },
      {
        title: "Nomenclature d’achat et prestations",
        table: {
          columns: [
            { key: "phase", label: "Phase" },
            { key: "type", label: "Type" },
            { key: "ref", label: "Référence / désignation" },
            { key: "qty", label: "Qté / pièce" },
            { key: "brut", label: "Brut (mm)" },
            { key: "pieces", label: "Nb pièces" },
            { key: "supplier", label: "Fournisseur" },
            { key: "scope", label: "Source" },
          ],
          rows: achats.map((a) => ({
            phase: a.phase,
            type: a.type,
            ref: joined(a.reference, a.designation),
            qty: a.qty,
            brut: joined(a.longueur_mm, a.brut_mm),
            pieces: a.pieces,
            supplier: a.supplier,
            scope: a.scope,
          })),
        },
      },
      {
        title: "Exigences documentaires de cette version",
        table: {
          columns: [
            { key: "label", label: "Document" },
            { key: "policy", label: "Règle" },
            { key: "critical", label: "Pièce critique" },
          ],
          rows: requirements.map((r) => ({
            label: r.label,
            policy: r.policy,
            critical: r.critical ? "Oui" : "Non",
          })),
        },
      },
      {
        title: "Documents GED liés à cette version",
        table: {
          columns: [
            { key: "role", label: "Rôle" },
            { key: "title", label: "Document" },
            { key: "version", label: "Version GED" },
            { key: "status", label: "Statut" },
            { key: "sha", label: "SHA-256" },
          ],
          rows: documents.map((d) => ({
            role: d.role,
            title: d.title,
            version: joined(d.version, d.version_id),
            status: d.status,
            sha: d.sha256,
          })),
        },
      },
    ],
  });
}
