import { HttpError } from "../../../utils/httpError";
import { buildInternalCreationSnapshot } from "../../../shared/authoritative-documents/internal-creation-snapshot";

type Row = Record<string, unknown>;
const row = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
const list = (v: unknown): Row[] => (Array.isArray(v) ? v.map(row) : []);
const text = (v: unknown) => (v == null ? null : String(v).trim() || null);
const joined = (...v: unknown[]) =>
  v.map(text).filter(Boolean).join(" — ") || null;

export function buildOfTraveler(source: unknown) {
  const data = row(source),
    of = row(data.of),
    snapshot = row(of.snapshot);
  const ops = list(data.operations),
    visas = list(data.visas),
    reservations = list(data.reservations);
  const debits = list(data.debits),
    cuts = list(data.cuts),
    remnants = list(data.remnants),
    declarations = list(data.declarations);
  const documents = list(snapshot.documents);
  if (
    [
      ops,
      visas,
      reservations,
      debits,
      cuts,
      remnants,
      declarations,
      documents,
    ].some((items) => items.length > 250)
  )
    throw new HttpError(
      422,
      "OF_TRAVELER_TOO_LARGE",
      "L’historique dépasse 250 lignes dans une rubrique. Utilisez le dossier détaillé avant édition.",
    );
  if (!text(of.numero))
    throw new HttpError(
      422,
      "OF_TRAVELER_SOURCE_INVALID",
      "La référence OF est manquante.",
    );
  const debitReferences = new Map(
    debits.map((d, i) => [text(d.id), `D${i + 1}`]),
  );
  return buildInternalCreationSnapshot({
    entityLabel: `${text(of.designation) ?? "Pièce non renseignée"}`,
    reference: text(of.numero)!,
    summary: [
      { label: "Statut OF", value: of.status },
      { label: "Quantité lancée", value: of.quantity },
      { label: "Pièce", value: of.reference },
      { label: "Indice client", value: of.indice },
      { label: "Version interne", value: of.version },
      { label: "Client", value: joined(of.client_code, of.client) },
    ],
    sections: [
      {
        title: "Dossier de fabrication",
        rows: [
          { label: "Commande", value: of.commande },
          { label: "Référence plan", value: of.plan },
          { label: "Version technique (UUID)", value: of.version_id },
          { label: "Empreinte technique OF", value: of.technical_hash },
          { label: "Échéance client de la ligne", value: of.customer_due },
          { label: "Échéance interne de la ligne", value: of.internal_due },
        ],
        notes: of.technical_hash
          ? "Les références techniques proviennent du dossier figé de cet OF. Les quantités et les visas représentent l’exécution enregistrée au moment de cette édition."
          : "OF historique : aucun dossier technique gelé n’est disponible. Les références historiques ne constituent pas une preuve d’indice applicable.",
      },
      {
        title: "Opérations et quantités nettes — corrections incluses",
        table: {
          columns: [
            { key: "phase", label: "Phase" },
            { key: "op", label: "Opération / machine" },
            { key: "status", label: "État" },
            { key: "good", label: "Bonnes" },
            { key: "scrap", label: "Rebuts" },
            { key: "pending", label: "À contrôler" },
            { key: "rework", label: "Retouche" },
            { key: "times", label: "TR / T/P (h)" },
          ],
          rows: ops.map((o) => ({
            phase: o.phase,
            op: joined(o.label, o.machine),
            status: o.status,
            good: o.good,
            scrap: o.scrap,
            pending: o.pending,
            rework: o.rework,
            times: joined(o.reglage_h, o.piece_h),
          })),
        },
      },
      {
        title: "Visas enregistrés — signatures non révoquées",
        table: {
          columns: [
            { key: "phase", label: "Phase" },
            { key: "visa", label: "Visa opérateur" },
            { key: "date", label: "Date" },
            { key: "status", label: "État" },
            { key: "good", label: "Bonnes" },
            { key: "scrap", label: "Rebuts" },
            { key: "control", label: "Visa contrôle" },
            { key: "note", label: "Commentaire" },
          ],
          rows: visas.map((v) => ({
            phase: v.phase,
            visa: joined(v.initials, v.operator),
            date: v.at,
            status: v.status,
            good: v.good,
            scrap: v.scrap,
            control: v.control,
            note: v.note,
          })),
        },
      },
      {
        title: "Lots matière réservés et consommés",
        table: {
          columns: [
            { key: "lot", label: "Lot utilisé" },
            { key: "origin", label: "Lot MP d’origine" },
            { key: "ref", label: "Article" },
            { key: "reserved", label: "Réservé" },
            { key: "consumed", label: "Consommé" },
            { key: "unit", label: "Unité" },
            { key: "status", label: "État réservation" },
          ],
          rows: reservations.map((r) => ({
            lot: r.lot,
            origin: r.root_lots,
            ref: r.reference,
            reserved: r.reserved,
            consumed: r.consumed,
            unit: r.unit,
            status: r.status,
          })),
        },
      },
      {
        title: "Débits et bruts déclarés",
        table: {
          columns: [
            { key: "ref", label: "Débit / phase" },
            { key: "date", label: "Date" },
            { key: "kind", label: "Nature quantité" },
            { key: "good", label: "Bruts bons" },
            { key: "scrap", label: "Rebuts" },
            { key: "actor", label: "Déclaré par" },
            { key: "correction", label: "Correction" },
          ],
          rows: debits.map((d) => ({
            ref: joined(debitReferences.get(text(d.id)), d.phase),
            date: d.at,
            kind: d.kind,
            good: d.good,
            scrap: d.scrap,
            actor: d.actor,
            correction: d.compensates
              ? `Compense ${debitReferences.get(text(d.compensates)) ?? text(d.compensates)}`
              : d.corrected_by
                ? `Corrigé par ${debitReferences.get(text(d.corrected_by)) ?? text(d.corrected_by)}`
                : null,
          })),
        },
        notes:
          "Les bruts sont déclarés par débit. Une quantité possible avant tournage n’est pas une quantité réelle. La répartition par lot ci-dessous provient des saisies observées ; les valeurs historiques absentes ne sont pas calculées au prorata des longueurs.",
      },
      {
        title: "Sorties matière par lot — découpe et solde des barres",
        table: {
          columns: [
            { key: "debit", label: "Débit" },
            { key: "lot", label: "Lot" },
            { key: "cut", label: "Sortie découpe" },
            { key: "actual", label: "Sortie totale" },
            { key: "discard", label: "Reliquat écarté" },
            { key: "unit", label: "Unité" },
            { key: "closed", label: "Barre soldée" },
          ],
          rows: cuts.map((c) => ({
            debit: debitReferences.get(text(c.debit_id)),
            lot: c.lot,
            cut: c.cut,
            actual: c.actual,
            discard: c.discarded,
            unit: c.unit,
            closed: c.closed ? "Oui" : "Non",
          })),
        },
      },
      {
        title: "Bruts obtenus par lot matière — preuves observées",
        table: {
          columns: [
            { key: "debit", label: "Débit" },
            { key: "lot", label: "Lot utilisé" },
            { key: "origin", label: "Lot MP d’origine" },
            { key: "need", label: "Besoin matière" },
            { key: "good", label: "Bons / potentiels" },
            { key: "scrap", label: "Rebuts" },
          ],
          rows: cuts.map((c) => ({
            debit: debitReferences.get(text(c.debit_id)),
            lot: c.lot,
            origin: c.root_lots,
            need: c.need,
            good: c.good ?? "Non renseigné",
            scrap: c.scrap ?? "Non renseigné",
          })),
        },
        notes: "Les totaux sont contrôlés pour chaque besoin matière. Les besoins distincts ne sont pas additionnés entre eux ; une correction conserve la répartition avec des quantités inverses.",
      },
      {
        title: "Identifiants des preuves de débit et de stock",
        table: {
          columns: [
            { key: "debit", label: "Débit" },
            { key: "id", label: "Identifiant preuve" },
            { key: "movement", label: "Mouvement stock / lot" },
          ],
          rows: debits.map((d) => ({
            debit: debitReferences.get(text(d.id)),
            id: d.id,
            movement: cuts
              .filter((c) => c.debit_id === d.id)
              .map((c) => joined(c.movement, c.lot))
              .join("\n"),
          })),
        },
      },
      {
        title: "Reliquats et retours en stock",
        table: {
          columns: [
            { key: "debit", label: "Débit" },
            { key: "lot", label: "Lot retourné" },
            { key: "qty", label: "Quantité" },
            { key: "unit", label: "Unité" },
            { key: "dimensions", label: "Dimensions (mm)" },
          ],
          rows: remnants.map((r) => ({
            debit: debitReferences.get(text(r.debit_id)),
            lot: r.lot,
            qty: r.quantity,
            unit: r.unit,
            dimensions: Object.entries(row(r.dimensions))
              .map(([k, v]) => `${k}: ${text(v) ?? "—"}`)
              .join(", "),
          })),
        },
      },
      {
        title: "Déclarations de production — historique des corrections",
        table: {
          columns: [
            { key: "phase", label: "Phase" },
            { key: "date", label: "Date" },
            { key: "actor", label: "Déclaré par" },
            { key: "good", label: "Bonnes" },
            { key: "scrap", label: "Rebuts" },
            { key: "other", label: "Contrôle / retouche" },
            { key: "reason", label: "Motif / correction" },
          ],
          rows: declarations.map((d) => ({
            phase: d.phase,
            date: d.at,
            actor: d.actor,
            good: d.good,
            scrap: d.scrap,
            other: joined(d.pending, d.rework),
            reason: joined(
              d.compensates ? `Compensation ${text(d.compensates)}` : null,
              d.reason,
            ),
          })),
        },
      },
      {
        title: "Documents techniques figés dans l’OF",
        table: {
          columns: [
            { key: "role", label: "Rôle" },
            { key: "document", label: "Document GED" },
            { key: "version", label: "Version GED" },
            { key: "sha", label: "SHA-256" },
          ],
          rows: documents.map((d) => ({
            role: d.role,
            document: d.id,
            version: d.version_id,
            sha: d.sha256,
          })),
        },
      },
    ],
  });
}
