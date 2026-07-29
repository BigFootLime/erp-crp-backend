// Rendu serveur du document d'OF — « ORDRE DE FABRICATION — GAMME APPLICABLE ».
//
// La pièce est un ORDRE DE FABRICATION. Ce n'est pas une gamme de fabrication :
// une gamme est la définition technique d'une pièce, réutilisable d'un OF à
// l'autre ; un ordre de fabrication est l'ordre de LANCER une quantité donnée,
// pour une commande donnée, à une date donnée. Il EMBARQUE la gamme applicable —
// la section « Gamme applicable » — mais il ne s'y réduit pas, et le titre du
// document ne doit pas laisser croire le contraire (issue #370).
//
// Le document est **opposable** : il accompagne la fabrication, il est haché,
// versé à la GED et réimprimable à l'identique. Il est donc rendu par le serveur
// avec `pdfkit`, jamais dans le navigateur — ADR-0042 §1. `window.print()` n'est
// pas un document officiel : il dépend du poste, du bundle et du moteur.
//
// L'aperçu écran affiche ce même payload ; il ne recalcule rien.
//
// Grammaire partagée : `src/shared/pdf/cerp-document.ts`, miroir déclaré de
// `crp-systems-web/src/design-system/pdf/document-kit.tsx` (ADR-0040).

import { createHash } from "node:crypto";

import {
  renderCerpDocument,
  type CerpDocumentContext,
  type CerpLineColumn,
  type CerpLineRow,
} from "../../../shared/pdf/cerp-document";
import {
  formatDateFr,
  formatNumberFr,
  formatQuantity,
  type OfDocumentPayload,
} from "../domain/of-document";

/**
 * Colonnes de la gamme.
 *
 * `linesTable` réémet cet en-tête sur chaque page traversée et ne coupe jamais
 * une ligne en deux. La phase et son VISA étant deux colonnes de la **même**
 * ligne, ils ne peuvent structurellement pas être séparés par un saut de page —
 * la garantie vient de la géométrie, pas d'une vérification a posteriori.
 */
/*
 * Les libelles d'en-tete sont volontairement courts : a 6,9 pt avec interlettrage,
 * « FABRICATION » et « QTE BASE » depassent leur colonne et viennent chevaucher le
 * filet de tete. Un en-tete abrege et lisible vaut mieux qu'un en-tete complet et
 * casse. La largeur de « FAM. » tient compte du plus long code de famille, FTRAD.
 */
const GAMME_COLUMNS: CerpLineColumn[] = [
  { key: "phase", label: "Ph.", flex: 0.5 },
  // « DECOUPE » est le plus long code de famille (7 caractères) : la colonne doit
  // le tenir sur UNE ligne. Un code replié en « DECOUP / E » n'est plus un code —
  // une désignation peut se replier, un identifiant de référentiel non.
  // Largeur mesurée sur le rendu, pas estimée.
  { key: "famille", label: "Fam.", flex: 1.28 },
  // « CF » et non « Centre » : à 6,9 pt avec interlettrage, « Centre » déborde et
  // se replie en « CENTR / E » par-dessus le filet de tête. « CF » est le terme
  // maison (centres_frais) et tient largement.
  { key: "centre", label: "CF", flex: 0.7 },
  { key: "machine", label: "Machine", flex: 1.0 },
  { key: "designation", label: "Désignation", flex: 1.54 },
  { key: "tunit", label: "T unit.", flex: 0.85, align: "right" },
  { key: "preparation", label: "Prépa.", flex: 0.79, align: "right" },
  { key: "fabrication", label: "Fabric.", flex: 1.18, align: "right" },
  { key: "final", label: "Final", flex: 1.18, align: "right" },
  { key: "qte", label: "Qté", flex: 0.58, align: "right" },
  { key: "visa", label: "VISA", flex: 0.62 },
];

/**
 * Détail du VISA, une ligne par phase.
 *
 * Séparé de la gamme parce que huit champs de plus dans la table principale la
 * rendraient illisible à 6,9 pt. La solidarité phase/VISA est préservée : chaque
 * phase reste UNE ligne, et `linesTable` ne coupe jamais une ligne en deux.
 */
// Libellés volontairement courts et sur UNE ligne : « Qté bonne », « Qté rebut »
// et « V. ctrl » se replient à 6,9 pt et viennent rayer le filet de tête. Un
// en-tête abrégé et lisible vaut mieux qu'un en-tête complet et cassé.
const VISA_COLUMNS: CerpLineColumn[] = [
  { key: "phase", label: "Ph.", flex: 0.5 },
  { key: "statut", label: "Statut", flex: 1.0 },
  { key: "operateur", label: "Opérateur", flex: 1.45 },
  { key: "date", label: "Date", flex: 1.35 },
  { key: "bonne", label: "Bonnes", flex: 0.92, align: "right" },
  { key: "rebut", label: "Rebuts", flex: 0.92, align: "right" },
  { key: "motif", label: "Motif rebut", flex: 1.8 },
  { key: "visaOp", label: "Op.", flex: 0.62 },
  { key: "visaCtrl", label: "Ctrl", flex: 0.62 },
];

/** Réserve de cohésion d'une section ouverte par une table (ADR-0040 §5). */
const TABLE_SECTION_COHESION = 104;

export type OfDocumentRenderResult = {
  buffer: Buffer;
  sha256: string;
  byteSize: number;
};

/**
 * Rend le document et renvoie son binaire avec son empreinte.
 *
 * Déterministe par construction : tout ce qui entre dans le binaire vient du
 * payload figé — y compris `generatedAt`, qui alimente à la fois le pied de page
 * et la date de création des métadonnées PDF. Aucune horloge n'est lue ici.
 */
export async function renderOfDocument(payload: OfDocumentPayload): Promise<OfDocumentRenderResult> {
  const generatedAt = new Date(payload.generatedAt);
  if (Number.isNaN(generatedAt.getTime())) {
    throw new Error(`Horodatage de document invalide : ${payload.generatedAt}`);
  }

  const buffer = await renderCerpDocument(
    {
      documentType: "Ordre de fabrication",
      name: payload.ofNumero,
      code: payload.revisionCode,
      subtitle: buildSubtitle(payload),
      status: payload.ofStatut,
      flag: payload.watermark,
      monogramName: payload.clientNom ?? payload.ofNumero,
      generatedAt: formatDateTimeFr(payload.generatedAt),
      generatedBy: payload.auteur,
      watermark: payload.watermark,
      // Rattacher une page isolée à son exemplaire : l'atelier détache les pages.
      // Le gabarit figure au pied : deux PDF de même contenu rendus par deux
      // gabarits différents ne sont pas le même document, et une réimpression
      // doit pouvoir le prouver sans ouvrir la base.
      footerNote: `${payload.ofNumero} ${payload.revisionCode} — instantané ${payload.snapshotId} — empreinte ${payload.snapshotSha256.slice(0, 16)} — gabarit ${payload.templateVersion}`,
      title: `Ordre de fabrication ${payload.ofNumero} ${payload.revisionCode}`,
      subject: `OF ${payload.ofNumero} révision ${payload.revisionCode}`,
      creationDate: generatedAt,
    },
    (ctx) => {
      renderCoverHalf(ctx, payload);
      renderTechnicalHalf(ctx, payload);
      renderGamme(ctx, payload);
    }
  );

  return {
    buffer,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    byteSize: buffer.byteLength,
  };
}

/** « GAMME-45252966 v1 », ou le code seul si la version manque. */
function formatGammeVersion(payload: OfDocumentPayload): string | null {
  if (!payload.gammeCode && !payload.gammeVersion) return null;
  if (!payload.gammeVersion) return payload.gammeCode;
  if (!payload.gammeCode) return `v${payload.gammeVersion}`;
  return `${payload.gammeCode} v${payload.gammeVersion}`;
}

function buildSubtitle(payload: OfDocumentPayload): string | null {
  const parts = [payload.pieceReference, payload.pieceDesignation].filter(
    (part): part is string => Boolean(part && part.trim())
  );
  if (payload.pieceIndice) parts.push(`Indice ${payload.pieceIndice}`);
  return parts.length ? parts.join(" — ") : null;
}

// ---------------------------------------------------------------------------
// Page 1 — moitié haute : couverture commerciale
// ---------------------------------------------------------------------------

function renderCoverHalf(ctx: CerpDocumentContext, payload: OfDocumentPayload): void {
  // En-tête documentaire (#370). Les trois statuts sont distincts et affichés
  // séparément : fabrication (badge d'identité), définition technique (révision)
  // et pièce documentaire (« Statut doc. »).
  //
  // Cinq cellules et non six : le numéro d'OF est déjà le titre de la page, et le
  // répéter ici volait la largeur aux autres libellés — « STATUT DOCUMENTAIRE »
  // et « VERSION DE GAMME » se repliaient alors par-dessus leur propre valeur.
  // Les libellés sont courts pour tenir sur UNE ligne à cette largeur.
  ctx.legalStrip(
    [
      { label: "Révision", value: `${payload.revisionCode} — ${payload.revisionStatut}` },
      { label: "Statut doc.", value: payload.documentStatut },
      { label: "Gamme", value: formatGammeVersion(payload) },
      { label: "Commande", value: payload.commandeNumero },
      { label: "Client", value: payload.clientNom ?? payload.clientCode },
    ],
    { compact: true }
  );

  ctx.section("Affaires de livraison", { cohesion: TABLE_SECTION_COHESION });
  ctx.linesTable({
    columns: [
      { key: "numero", label: "Affaire", flex: 1.4 },
      { key: "delai", label: "Délai client", flex: 1.2 },
      { key: "quantite", label: "Quantité", flex: 1, align: "right" },
    ],
    rows: payload.affaires.map<CerpLineRow>((affaire) => ({
      cells: {
        numero: affaire.numero ?? `#${affaire.affaireId}`,
        delai: formatDateFr(affaire.delaiClient),
        quantite: formatQuantity(affaire.quantite),
      },
    })),
    emptyLabel: "Aucune affaire de livraison rattachée.",
  });

  if (payload.cadenceLivraison.length) {
    ctx.section("Cadence de livraison", { cohesion: TABLE_SECTION_COHESION });
    ctx.linesTable({
      columns: [
        { key: "date", label: "Échéance", flex: 1.2 },
        { key: "affaire", label: "Affaire", flex: 1.4 },
        { key: "quantite", label: "Quantité", flex: 1, align: "right" },
      ],
      rows: payload.cadenceLivraison.map<CerpLineRow>((echeance) => ({
        cells: {
          date: formatDateFr(echeance.date),
          affaire: echeance.affaireNumero ?? "—",
          quantite: formatQuantity(echeance.quantite),
        },
      })),
      emptyLabel: "Aucune cadence de livraison définie.",
    });
  }

  // Couverture de la demande. Les postes sont disjoints : leur somme et le reste
  // net redonnent la quantité demandée. Le document affiche donc une répartition,
  // pas une collection d'indicateurs qui pourraient se recouper.
  ctx.section("Couverture de la demande");
  const q = payload.quantites;
  const grid: Array<[string, string]> = [
    ["Quantité demandée", formatQuantity(q.quantiteDemandee)],
    ["Déjà livrée", formatQuantity(q.quantiteLivree)],
    ["Stock réservé", formatQuantity(q.stockReserve)],
    ["Couverte par d'autres OF actifs", formatQuantity(q.couvertAutresOf)],
    ["Affectée à cet OF", formatQuantity(q.quantiteAffecteeCetOf)],
    ["Reste net à couvrir", formatQuantity(q.resteNetACouvrir)],
  ];
  renderFieldGrid(ctx, grid, 3);

  if (q.surCouverture) {
    ctx.notes(
      `Sur-couverture de ${formatQuantity(q.excedent)} : les couvertures dépassent la quantité demandée. À arbitrer avant lancement.`
    );
  }

  if (payload.cadenceProduction.length || payload.derniereFabrication) {
    ctx.section("Décision de production");
    const production: Array<[string, string]> = [];
    if (payload.cadenceProduction.length) {
      production.push([
        "Cadence décidée en production",
        payload.cadenceProduction
          .map((c) => `${formatDateFr(c.date)} : ${formatQuantity(c.quantite)}`)
          .join("  |  "),
      ]);
    }
    if (payload.derniereFabrication) {
      production.push([
        "Dernière fabrication",
        [payload.derniereFabrication.numero, formatDateFr(payload.derniereFabrication.date)]
          .filter(Boolean)
          .join(" — ") || "—",
      ]);
    }
    renderFieldGrid(ctx, production, production.length > 1 ? 2 : 1);
  }
}

// ---------------------------------------------------------------------------
// Page 1 — moitié basse : pièce, gamme, matière, débit
// ---------------------------------------------------------------------------

function renderTechnicalHalf(ctx: CerpDocumentContext, payload: OfDocumentPayload): void {
  ctx.section("Pièce et gamme");
  renderFieldGrid(
    ctx,
    [
      ["Référence pièce", payload.pieceReference ?? "—"],
      ["Indice", payload.pieceIndice ?? "—"],
      ["Gamme", payload.gammeCode ?? "—"],
      ["Désignation", payload.pieceDesignation ?? "—"],
      ["Version de gamme", payload.gammeVersion ?? "—"],
      ["Séquence machines", payload.sequenceMachinesLabel],
    ],
    3
  );

  if (payload.documentsAFournir.length) {
    ctx.notesSection(
      "Documents à fournir",
      payload.documentsAFournir.map((doc) => `- ${doc}`).join("\n")
    );
  }

  ctx.section("Matière et découpe");
  renderFieldGrid(
    ctx,
    [
      ["Référence matière", payload.matiere.reference ?? "—"],
      ["Désignation", payload.matiere.designation ?? "—"],
      ["Nuance", payload.matiere.nuance ?? "—"],
      ["Dimensions", payload.decoupe.dimensions ?? "—"],
      ["Unité", payload.decoupe.unite ?? "—"],
      ["Pièces par brut", formatQuantity(payload.decoupe.piecesParBrut)],
      ["Longueur du brut", millimetres(payload.decoupe.longueurBrutMm, 0)],
      ["Longueur utile", millimetres(payload.decoupe.longueurUtileMm, 0)],
      ["Nombre de bruts", formatQuantity(payload.decoupe.nombreBruts)],
      // « si disponibles » : l'atelier ne renseigne pas toujours le trait de scie.
      // Un tiret dit « non renseigné » ; un 0 affirmerait une scie sans épaisseur.
      ["Trait de scie", millimetres(payload.decoupe.traitDeScieMm, 1)],
      ["Chute", millimetres(payload.decoupe.chuteMm, 1)],
      ["Longueur totale", millimetres(payload.decoupe.longueurTotaleMm, 2)],
      [
        "Masse totale",
        payload.decoupe.masseTotaleKg !== null
          ? `${formatNumberFr(payload.decoupe.masseTotaleKg, 3)} kg`
          : "— (non calculable)",
      ],
      ["Passages machines", `${payload.sequenceMachines.length}`],
      ["Séquence réelle", payload.sequenceMachinesLabel],
    ],
    3
  );

  // La méthode de calcul est imprimée sous le tableau : un magasinier doit
  // pouvoir refaire le calcul de la longueur totale, pas le croire sur parole.
  if (payload.decoupe.methodeCalcul) {
    ctx.notes(`Méthode de calcul — ${payload.decoupe.methodeCalcul}`);
  }
}

/** Longueur en millimètres, ou tiret explicite quand la donnée manque. */
function millimetres(value: number | null, decimals: number): string {
  return value !== null && value !== undefined
    ? `${formatNumberFr(value, decimals)} mm`
    : "—";
}

// ---------------------------------------------------------------------------
// Pages gamme
// ---------------------------------------------------------------------------

function renderGamme(ctx: CerpDocumentContext, payload: OfDocumentPayload): void {
  // « Gamme APPLICABLE » : celle qui s'applique à CET OF, figée par sa révision.
  // Pas « la gamme de la pièce », qui a pu bouger depuis le lancement.
  ctx.section("Gamme applicable", { cohesion: TABLE_SECTION_COHESION });

  ctx.linesTable({
    columns: GAMME_COLUMNS,
    rows: payload.phases.map<CerpLineRow>((phase) => ({
      cells: {
        phase: String(phase.phase),
        famille: phase.family ?? "—",
        centre: phase.centre ?? "—",
        machine: phase.machine ?? "—",
        designation: phase.designation,
        tunit: phase.tempsUnitaireLabel,
        preparation: phase.preparationLabel,
        fabrication: phase.fabricationLabel,
        final: phase.finalLabel,
        qte: formatQuantity(phase.quantiteBase),
        // Une case vide se remplit à la main en atelier : c'est la colonne du
        // papier. Un tiret laisserait croire que la phase n'a pas à être visée.
        visa: phase.visa.visaOperateur ?? "",
      },
      meta: buildPhaseMeta(phase),
      metaColumn: "designation",
    })),
    emptyLabel: "Aucune phase dans cette révision.",
  });

  ctx.section("Totaux");
  renderFieldGrid(
    ctx,
    [
      ["Préparation", payload.totaux.preparationLabel],
      ["Fabrication", payload.totaux.fabricationLabel],
      ["Total", payload.totaux.finalLabel],
    ],
    3
  );

  renderVisaDetail(ctx, payload);
  renderAvertissements(ctx, payload);

  ctx.signatureBox("Contrôle final", ["Nom", "Date", "Signature"]);
}

/**
 * Ligne secondaire d'une phase : n° de programme, ou son absence signalée.
 *
 * Un programme manquant sur une famille qui l'exige est écrit noir sur blanc.
 * L'omettre laisserait l'opérateur chercher un fichier qui n'a jamais été
 * référencé, et croire à une erreur de sa part.
 */
function buildPhaseMeta(phase: OfDocumentPayload["phases"][number]): string | null {
  if (phase.programme) return `Programme : ${phase.programme}`;
  if (phase.programmeManquant) return "Programme : NON RENSEIGNÉ — à obtenir avant lancement";
  return null;
}

function renderVisaDetail(ctx: CerpDocumentContext, payload: OfDocumentPayload): void {
  ctx.section("Contrôles et VISA", { cohesion: TABLE_SECTION_COHESION });

  ctx.linesTable({
    columns: VISA_COLUMNS,
    rows: payload.phases.map<CerpLineRow>((phase) => ({
      cells: {
        phase: String(phase.phase),
        statut: VISA_STATUT_LABELS[phase.visa.statut] ?? phase.visa.statut,
        operateur: phase.visa.operateur ?? "",
        date: phase.visa.visaAt ? formatDateTimeFr(phase.visa.visaAt) : "",
        bonne: phase.visa.quantiteBonne !== null ? formatQuantity(phase.visa.quantiteBonne) : "",
        rebut: phase.visa.quantiteRebut !== null ? formatQuantity(phase.visa.quantiteRebut) : "",
        motif: phase.visa.motifRebut ?? "",
        visaOp: phase.visa.visaOperateur ?? "",
        visaCtrl: phase.visa.visaControle ?? "",
      },
      meta: phase.visa.commentaire ? `Commentaire : ${phase.visa.commentaire}` : null,
      metaColumn: "motif",
    })),
    emptyLabel: "Aucune phase à viser.",
  });
}

const VISA_STATUT_LABELS: Record<string, string> = {
  A_FAIRE: "À faire",
  EN_COURS: "En cours",
  VISE: "Visé",
  REFUSE: "Refusé",
};

/**
 * Avertissements imprimés sur la pièce elle-même.
 *
 * Les laisser seulement à l'écran reviendrait à publier un document propre qui
 * tait ses propres trous : l'atelier travaille sur le papier, pas sur l'aperçu.
 */
function renderAvertissements(ctx: CerpDocumentContext, payload: OfDocumentPayload): void {
  if (!payload.avertissements.length) return;

  ctx.section("Signalements");
  ctx.notes(
    payload.avertissements
      .map((warning) => `[${warning.severite}] ${warning.message}`)
      .join("\n")
  );
}

// ---------------------------------------------------------------------------
// Grille de champs
// ---------------------------------------------------------------------------

/**
 * Champs disposés en colonnes, ligne par ligne.
 *
 * La hauteur d'une ligne est celle de son champ le plus haut : une désignation
 * longue ne doit pas chevaucher la ligne suivante.
 */
function renderFieldGrid(
  ctx: CerpDocumentContext,
  entries: Array<[string, string]>,
  columns: number
): void {
  if (!entries.length) return;
  const contentWidth = 519.28;
  const gap = 16;
  const width = (contentWidth - gap * (columns - 1)) / columns;
  const marginX = 38;

  for (let index = 0; index < entries.length; index += columns) {
    const row = entries.slice(index, index + columns);
    ctx.ensureSpace(34);
    const top = ctx.y;
    let bottom = top;

    row.forEach((entry, column) => {
      ctx.y = top;
      const end = ctx.field(entry[0], entry[1], marginX + (width + gap) * column, width);
      if (end > bottom) bottom = end;
    });

    ctx.y = bottom + 8;
  }
}

function formatDateTimeFr(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  // UTC : deux serveurs de fuseaux différents doivent produire le même document.
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()} à ${pad(
    date.getUTCHours()
  )}:${pad(date.getUTCMinutes())}`;
}
