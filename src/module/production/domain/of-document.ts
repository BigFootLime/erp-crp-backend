// Read-model du document d'OF — « ORDRE DE FABRICATION — GAMME APPLICABLE ».
//
// Un seul payload alimente l'aperçu écran ET le PDF serveur. Il est figé dans
// `of_documents` : une réimpression rejoue l'instantané et reproduit le même
// binaire, donc la même empreinte. Ce module ne lit aucune base et n'appelle
// aucune horloge — il transforme une entrée en payload, de façon déterministe.
//
// Structure du document, calquée sur la gamme papier de l'atelier :
//   - page 1, moitié haute : couverture commerciale (commande, affaires de
//     livraison, cadence, quantités) ;
//   - page 1, moitié basse : pièce, gamme, matière, débit, séquence machines ;
//   - pages suivantes : la gamme phase par phase, avec TP, TF et VISA.

import {
  familyLabel,
  hashSnapshot,
  phaseFabricationTime,
  phaseFinalTime,
  type MachineFamilyRef,
  type OfPhaseFamily,
  type OfRevisionOperation,
} from "./of-revision";

export const OF_DOCUMENT_SCHEMA = "of-document/1" as const;

/**
 * Version du gabarit de rendu.
 *
 * Elle entre dans le payload figé, donc dans son empreinte. Toute modification du
 * dessin du document — colonne ajoutée, libellé changé, marge retouchée — doit
 * l'incrémenter : deux PDF de même contenu produits par deux gabarits différents
 * ne sont pas le même document, et une réimpression doit pouvoir le prouver.
 *
 * Renommé et incrémenté le 2026-07-29 : la pièce est un ORDRE DE FABRICATION, pas
 * une gamme de fabrication. Le libellé du document a changé, donc le binaire aussi.
 */
export const OF_DOCUMENT_TEMPLATE_VERSION = "of-ordre-fabrication/1.2" as const;

// ---------------------------------------------------------------------------
// Formatage
// ---------------------------------------------------------------------------

/**
 * Durée lisible à partir d'un nombre d'heures décimal : « 6 min », « 1 h 20 min »,
 * « 4 h ».
 *
 * La gamme papier affiche des centièmes d'heure (0,08 h) que personne ne convertit
 * de tête à l'atelier. Le document imprimé donne la durée telle qu'on la vit.
 */
export function formatDuration(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return "—";
  const totalMinutes = Math.round(hours * 60);
  if (totalMinutes === 0) return "0 min";

  const sign = totalMinutes < 0 ? "-" : "";
  const abs = Math.abs(totalMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;

  if (h === 0) return `${sign}${m} min`;
  if (m === 0) return `${sign}${h} h`;
  return `${sign}${h} h ${m} min`;
}

/** Nombre à la française : « 2 280,00 », séparateur de milliers insécable fin. */
export function formatNumberFr(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const fixed = Math.abs(value).toFixed(decimals);
  const [intPart, decPart] = fixed.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const sign = value < 0 ? "-" : "";
  return decPart ? `${sign}${grouped},${decPart}` : `${sign}${grouped}`;
}

/** Quantité : décimales seulement si elles portent une information. */
export function formatQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? formatNumberFr(value, 0) : formatNumberFr(value, 3);
}

export function formatDateFr(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return String(iso);
}

// ---------------------------------------------------------------------------
// Quantités — le cœur du non-double-comptage
// ---------------------------------------------------------------------------

export type OfQuantityInput = {
  /** Quantité commandée par le client, toutes affaires de livraison confondues. */
  quantiteDemandee: number;
  /** Déjà expédié et accepté. */
  quantiteLivree: number;
  /** Stock physique réservé pour cette demande. */
  stockReserve: number;
  /**
   * Quantité couverte par d'**autres** OF encore actifs sur la même demande.
   * L'OF courant en est exclu par construction.
   */
  couvertAutresOf: number;
  /** Quantité que cet OF s'engage à produire. */
  quantiteAffecteeCetOf: number;
};

export type OfQuantityCoverage = OfQuantityInput & {
  /** Ce que plus rien ne couvre. Jamais négatif. */
  resteNetACouvrir: number;
  /** Somme des couvertures. Doit égaler la demande quand le reste net est nul. */
  totalCouvert: number;
  /** `true` si les couvertures dépassent la demande : signal de sur-couverture. */
  surCouverture: boolean;
  /** Excédent de couverture, positif seulement. */
  excedent: number;
};

/**
 * Répartit la demande en postes **disjoints**.
 *
 * Chaque unité commandée appartient à un poste et un seul : livrée, ou réservée
 * sur stock, ou couverte par un autre OF actif, ou affectée à cet OF, ou non
 * couverte. C'est ce qui interdit le double comptage.
 *
 * Deux confusions classiques que cette répartition évite :
 *
 *  - **Stock réservé et OF terminé.** La sortie d'un OF terminé est entrée en
 *    stock : la compter à la fois comme production en cours et comme stock
 *    réservé couvrirait deux fois la même pièce. Seuls les OF **actifs** entrent
 *    dans `couvertAutresOf` — l'appelant en est responsable.
 *  - **L'OF courant compté deux fois.** `couvertAutresOf` exclut l'OF du
 *    document ; sa part vit dans `quantiteAffecteeCetOf`.
 */
export function computeQuantityCoverage(input: OfQuantityInput): OfQuantityCoverage {
  const demandee = nonNegative(input.quantiteDemandee);
  const livree = nonNegative(input.quantiteLivree);
  const reserve = nonNegative(input.stockReserve);
  const autres = nonNegative(input.couvertAutresOf);
  const cetOf = nonNegative(input.quantiteAffecteeCetOf);

  const totalCouvert = round3(livree + reserve + autres + cetOf);
  const solde = round3(demandee - totalCouvert);

  return {
    quantiteDemandee: demandee,
    quantiteLivree: livree,
    stockReserve: reserve,
    couvertAutresOf: autres,
    quantiteAffecteeCetOf: cetOf,
    resteNetACouvrir: solde > 0 ? solde : 0,
    totalCouvert,
    surCouverture: solde < 0,
    excedent: solde < 0 ? round3(-solde) : 0,
  };
}

function nonNegative(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return round3(value);
}

function round3(value: number): number {
  return Math.round(value * 1e3) / 1e3;
}

// ---------------------------------------------------------------------------
// Séquence machines
// ---------------------------------------------------------------------------

export type OfMachineSequenceStep = {
  family: OfPhaseFamily;
  label: string;
  /** Nombre de phases consécutives de cette famille. */
  passages: number;
  /** Phases concernées, dans l'ordre. */
  phases: number[];
};

/**
 * Synthèse compacte des séquences machines, **dans l'ordre réel de fabrication**.
 *
 * Deux règles, et elles comptent autant l'une que l'autre :
 *
 *  - Seules les phases **consécutives** d'une même famille sont regroupées. Une
 *    séquence `T -> F -> T` reste trois passages : regrouper les deux tournages
 *    effacerait le fait que la pièce repasse en tournage après le fraisage, qui
 *    est précisément ce que l'atelier lit sur cette ligne.
 *  - Une phase **sans famille** d'usinage (emballage, expédition, contrôle) ne
 *    figure pas dans la séquence — ce n'est pas un passage machine — mais elle
 *    **interrompt** le regroupement. `F -> emballage -> F` reste donc deux
 *    passages de fraisage, et non un seul : la pièce est bien retournée en
 *    machine.
 */
export function buildMachineSequence(
  operations: Array<Pick<OfRevisionOperation, "phase" | "family">>
): OfMachineSequenceStep[] {
  const ordered = [...operations].sort((a, b) => a.phase - b.phase);
  const steps: OfMachineSequenceStep[] = [];
  let openStep: OfMachineSequenceStep | null = null;

  for (const operation of ordered) {
    if (operation.family === null) {
      openStep = null;
      continue;
    }
    if (openStep && openStep.family === operation.family) {
      openStep.passages += 1;
      openStep.phases.push(operation.phase);
      continue;
    }
    openStep = {
      family: operation.family,
      label: operation.family,
      passages: 1,
      phases: [operation.phase],
    };
    steps.push(openStep);
  }

  return steps;
}

/** « 3 F -> 2 T -> 1 F », lisible d'un coup d'œil. */
export function formatMachineSequence(steps: OfMachineSequenceStep[]): string {
  if (!steps.length) return "—";
  return steps
    .map((step) => (step.passages > 1 ? `${step.passages} ${step.label}` : step.label))
    .join(" -> ");
}

// ---------------------------------------------------------------------------
// Payload du document
// ---------------------------------------------------------------------------

export type OfDocumentAffaire = {
  affaireId: number;
  numero: string | null;
  /** Engagement client accusé, ISO. */
  delaiClient: string | null;
  quantite: number | null;
};

export type OfDocumentCadence = {
  date: string;
  quantite: number;
  affaireNumero: string | null;
};

/**
 * Bloc VISA d'une phase.
 *
 * Il est **imprimé même vide** : c'est la case que l'atelier remplit au stylo
 * quand la saisie écran n'est pas possible. Un document qui n'imprimerait la
 * zone que si elle est déjà remplie serait inutilisable au poste.
 */
export type OfDocumentVisa = {
  /** 'A_FAIRE', 'EN_COURS', 'VISE', 'REFUSE'. */
  statut: string;
  operateur: string | null;
  /** ISO, ou `null` si la phase n'est pas visée. */
  visaAt: string | null;
  quantiteBonne: number | null;
  quantiteRebut: number | null;
  motifRebut: string | null;
  /** Initiales de l'opérateur qui a fait la phase. */
  visaOperateur: string | null;
  /** Initiales du contrôle — distinct de l'opérateur, c'est le principe. */
  visaControle: string | null;
  commentaire: string | null;
};

export type OfDocumentPhase = {
  phase: number;
  family: OfPhaseFamily | null;
  familyLabel: string | null;
  /** Centre de frais affecté (code figé au lancement). */
  centre: string | null;
  machine: string | null;
  designation: string;
  programme: string | null;
  /** `true` = la famille exige un n° de programme et il manque. Signalé, jamais inventé. */
  programmeManquant: boolean;
  /** Heures décimales, conservées pour l'aperçu et les contrôles. */
  tempsUnitaireH: number;
  preparationH: number;
  fabricationH: number;
  finalH: number;
  quantiteBase: number;
  coefficient: number;
  /** Libellés prêts à imprimer, calculés une fois pour les deux rendus. */
  tempsUnitaireLabel: string;
  preparationLabel: string;
  fabricationLabel: string;
  finalLabel: string;
  visa: OfDocumentVisa;
};

export type OfDocumentDecoupe = {
  /** Section ou diamètre du brut, tel que saisi (« Ø 40 », « 40 x 20 »). */
  dimensions: string | null;
  longueurBrutMm: number | null;
  /** Longueur réellement exploitable d'un brut, hors prise en pince et chute. */
  longueurUtileMm: number | null;
  /** Épaisseur du trait de scie, en mm. `null` si l'atelier ne l'a pas renseigné. */
  traitDeScieMm: number | null;
  /** Chute résiduelle par brut, en mm. */
  chuteMm: number | null;
  nombreBruts: number | null;
  piecesParBrut: number | null;
  longueurTotaleMm: number | null;
  masseTotaleKg: number | null;
  /** Unité de la matière : 'MM', 'KG', 'U'… telle que le référentiel la porte. */
  unite: string | null;
  /**
   * Comment la longueur totale a été obtenue. Imprimée sous le tableau de débit :
   * un magasinier qui coupe doit pouvoir refaire le calcul, pas le croire.
   */
  methodeCalcul: string | null;
};

/**
 * Avertissement porté par le document.
 *
 * Critère d'acceptation #370 : « aucune donnée absente du backend n'est inventée :
 * une donnée manquante est signalée, jamais remplacée ». Ces avertissements sont
 * la forme que prend ce signalement — dans le panneau latéral de l'aperçu, et
 * imprimés sur la pièce elle-même.
 */
export type OfDocumentWarning = {
  code: string;
  severite: "INFO" | "ATTENTION" | "BLOQUANT";
  message: string;
  /** Phase concernée, si l'avertissement en vise une. */
  phase?: number;
};

export type OfDocumentPayload = {
  schema: typeof OF_DOCUMENT_SCHEMA;

  // Identité du document
  /** UUID immuable de l'OF. Distinct du numéro métier : il ne s'affiche pas, il tracé. */
  ofUuid: string | null;
  ofNumero: string;
  revisionCode: string;
  revisionStatut: string;
  ofStatut: string;
  /**
   * Statut **documentaire** : 'BROUILLON', 'OFFICIEL', 'OBSOLETE'.
   *
   * Volontairement distinct de `ofStatut` (état de fabrication) et de
   * `revisionStatut` (état de la définition technique). Un OF « En cours » peut
   * porter un document OBSOLETE si une R01 l'a remplacé : confondre les trois
   * ferait fabriquer d'après une gamme périmée.
   */
  documentStatut: string;
  /** Version du gabarit de rendu. Un changement de gabarit change le binaire. */
  templateVersion: string;
  snapshotId: string;
  snapshotSha256: string;
  auteur: string | null;
  /** Horodatage figé, ISO. Entre dans les métadonnées du PDF. */
  generatedAt: string;
  /** Filigrane à imprimer, ou `null`. */
  watermark: string | null;

  // Page 1 — moitié haute
  commandeNumero: string | null;
  clientCode: string | null;
  clientNom: string | null;
  affaires: OfDocumentAffaire[];
  cadenceLivraison: OfDocumentCadence[];
  quantites: OfQuantityCoverage;
  cadenceProduction: OfDocumentCadence[];
  derniereFabrication: { numero: string | null; date: string | null } | null;

  // Page 1 — moitié basse
  pieceReference: string | null;
  pieceDesignation: string | null;
  pieceIndice: string | null;
  gammeCode: string | null;
  gammeVersion: string | null;
  documentsAFournir: string[];
  matiere: {
    reference: string | null;
    designation: string | null;
    nuance: string | null;
  };
  decoupe: OfDocumentDecoupe;
  sequenceMachines: OfMachineSequenceStep[];
  sequenceMachinesLabel: string;

  // Pages gamme
  phases: OfDocumentPhase[];
  totaux: {
    preparationH: number;
    fabricationH: number;
    finalH: number;
    preparationLabel: string;
    fabricationLabel: string;
    finalLabel: string;
  };

  /** Données manquantes ou incohérentes, signalées et non comblées. */
  avertissements: OfDocumentWarning[];
};

export type OfDocumentBuildInput = {
  ofUuid?: string | null;
  ofNumero: string;
  revisionCode: string;
  revisionStatut: string;
  ofStatut: string;
  documentStatut?: string;
  templateVersion?: string;
  snapshotId: string;
  snapshotSha256: string;
  auteur: string | null;
  generatedAt: string;
  watermark?: string | null;

  commandeNumero: string | null;
  clientCode: string | null;
  clientNom: string | null;
  affaires: OfDocumentAffaire[];
  cadenceLivraison: OfDocumentCadence[];
  quantites: OfQuantityInput;
  cadenceProduction: OfDocumentCadence[];
  derniereFabrication: { numero: string | null; date: string | null } | null;

  pieceReference: string | null;
  pieceDesignation: string | null;
  pieceIndice: string | null;
  gammeCode: string | null;
  gammeVersion: string | null;
  documentsAFournir: string[];
  matiere: { reference: string | null; designation: string | null; nuance: string | null };
  decoupe: Omit<OfDocumentDecoupe, "longueurTotaleMm"> & { longueurTotaleMm?: number | null };

  operations: OfRevisionOperation[];
  /** VISA par phase, tel qu'enregistré. Absent = phase non visée, zone imprimée vide. */
  visas: Record<number, Partial<OfDocumentVisa> | undefined>;
  /**
   * Référentiel des familles machine. Facultatif : sans lui les libellés
   * retombent sur le repli, mais `programmeRequis` ne peut plus être vérifié —
   * l'absence de contrôle est alors signalée, pas silencieuse.
   */
  familles?: readonly MachineFamilyRef[];
};

/**
 * Construit le payload figé.
 *
 * Tous les libellés sont calculés ici, une fois, et non à l'affichage : c'est ce
 * qui garantit que l'aperçu écran et le PDF montrent exactement la même chose. Un
 * formatage refait de chaque côté finirait par diverger sur un arrondi.
 */
export function buildOfDocumentPayload(input: OfDocumentBuildInput): OfDocumentPayload {
  const operations = [...input.operations].sort((a, b) => a.phase - b.phase);
  const familles = input.familles;
  const avertissements: OfDocumentWarning[] = [];

  const phases = operations.map<OfDocumentPhase>((operation) => {
    const fabrication = phaseFabricationTime(operation);
    const final = phaseFinalTime(operation);
    const visa = input.visas[operation.phase] ?? {};

    // Le n° de programme n'est obligatoire que sur les familles qui l'exigent
    // (`programme_requis` du référentiel). Sur une famille qui ne l'exige pas,
    // son absence n'est pas un défaut et ne doit pas polluer les avertissements.
    const famille = operation.family
      ? familles?.find((f) => f.code === operation.family)
      : undefined;
    const programmeManquant = Boolean(famille?.programmeRequis) && !operation.programme;

    if (programmeManquant) {
      avertissements.push({
        code: "PROGRAMME_MANQUANT",
        severite: "ATTENTION",
        phase: operation.phase,
        message: `Phase ${operation.phase} (${famille?.libelle ?? operation.family}) : n° de programme absent alors que la famille l'exige.`,
      });
    }

    if (operation.family && familles && !famille) {
      avertissements.push({
        code: "FAMILLE_INCONNUE",
        severite: "ATTENTION",
        phase: operation.phase,
        message: `Phase ${operation.phase} : famille « ${operation.family} » absente du référentiel machine.`,
      });
    }

    return {
      phase: operation.phase,
      family: operation.family,
      familyLabel: familyLabel(operation.family, familles),
      centre: operation.cfCode,
      machine: operation.machineLabel,
      designation: operation.designation,
      programme: operation.programme,
      programmeManquant,
      tempsUnitaireH: operation.tempsUnitaire,
      preparationH: operation.preparation,
      fabricationH: round4(fabrication),
      finalH: round4(final),
      quantiteBase: operation.quantiteBase,
      coefficient: operation.coefficient,
      tempsUnitaireLabel: formatDuration(operation.tempsUnitaire),
      preparationLabel: formatDuration(operation.preparation),
      fabricationLabel: formatDuration(fabrication),
      finalLabel: formatDuration(final),
      visa: {
        statut: visa.statut ?? "A_FAIRE",
        operateur: visa.operateur ?? null,
        visaAt: visa.visaAt ?? null,
        quantiteBonne: visa.quantiteBonne ?? null,
        quantiteRebut: visa.quantiteRebut ?? null,
        motifRebut: visa.motifRebut ?? null,
        visaOperateur: visa.visaOperateur ?? null,
        visaControle: visa.visaControle ?? null,
        commentaire: visa.commentaire ?? null,
      },
    };
  });

  if (!familles) {
    avertissements.push({
      code: "REFERENTIEL_FAMILLES_ABSENT",
      severite: "INFO",
      message:
        "Référentiel des familles machine non chargé : les n° de programme obligatoires n'ont pas pu être contrôlés.",
    });
  }

  if (!operations.length) {
    avertissements.push({
      code: "GAMME_VIDE",
      severite: "BLOQUANT",
      message: "Aucune phase dans la gamme applicable : le document ne décrit aucune fabrication.",
    });
  }

  const preparationH = round4(phases.reduce((sum, p) => sum + p.preparationH, 0));
  const fabricationH = round4(phases.reduce((sum, p) => sum + p.fabricationH, 0));
  const finalH = round4(preparationH + fabricationH);

  const sequenceMachines = buildMachineSequence(operations);

  // Longueur totale de matière : longueur d'un brut x nombre de bruts. Calculée
  // seulement quand les deux termes sont connus — une valeur inventée sur un
  // document de débit enverrait le magasin couper la mauvaise barre.
  const calculable =
    input.decoupe.longueurBrutMm !== null && input.decoupe.nombreBruts !== null;
  const longueurTotaleMm =
    input.decoupe.longueurTotaleMm ??
    (calculable ? round3(input.decoupe.longueurBrutMm! * input.decoupe.nombreBruts!) : null);

  // La méthode est imprimée sous le tableau : un magasinier doit pouvoir refaire
  // le calcul, pas le croire sur parole.
  const methodeCalcul =
    input.decoupe.methodeCalcul ??
    (input.decoupe.longueurTotaleMm !== null && input.decoupe.longueurTotaleMm !== undefined
      ? "Longueur totale fournie par la définition matière."
      : calculable
        ? `Longueur totale = longueur de brut (${formatNumberFr(input.decoupe.longueurBrutMm, 1)} mm) x nombre de bruts (${formatQuantity(input.decoupe.nombreBruts)}).`
        : null);

  if (longueurTotaleMm === null) {
    avertissements.push({
      code: "DECOUPE_INCOMPLETE",
      severite: "ATTENTION",
      message:
        "Longueur totale de matière non calculable : longueur de brut ou nombre de bruts absent. Aucune valeur n'est déduite.",
    });
  }

  const quantites = computeQuantityCoverage(input.quantites);

  if (quantites.surCouverture) {
    avertissements.push({
      code: "SUR_COUVERTURE",
      severite: "ATTENTION",
      message: `Les couvertures dépassent la demande de ${formatQuantity(quantites.excedent)} : vérifier les réservations et les OF concurrents.`,
    });
  }

  if (quantites.resteNetACouvrir > 0) {
    avertissements.push({
      code: "RESTE_A_COUVRIR",
      severite: "INFO",
      message: `Reste net à couvrir : ${formatQuantity(quantites.resteNetACouvrir)}.`,
    });
  }

  return {
    schema: OF_DOCUMENT_SCHEMA,
    ofUuid: input.ofUuid ?? null,
    ofNumero: input.ofNumero,
    revisionCode: input.revisionCode,
    revisionStatut: input.revisionStatut,
    ofStatut: input.ofStatut,
    documentStatut: input.documentStatut ?? "BROUILLON",
    templateVersion: input.templateVersion ?? OF_DOCUMENT_TEMPLATE_VERSION,
    snapshotId: input.snapshotId,
    snapshotSha256: input.snapshotSha256,
    auteur: input.auteur,
    generatedAt: input.generatedAt,
    watermark: input.watermark ?? null,

    commandeNumero: input.commandeNumero,
    clientCode: input.clientCode,
    clientNom: input.clientNom,
    affaires: [...input.affaires].sort((a, b) => a.affaireId - b.affaireId),
    cadenceLivraison: [...input.cadenceLivraison].sort((a, b) => a.date.localeCompare(b.date)),
    quantites,
    cadenceProduction: [...input.cadenceProduction].sort((a, b) => a.date.localeCompare(b.date)),
    derniereFabrication: input.derniereFabrication,

    pieceReference: input.pieceReference,
    pieceDesignation: input.pieceDesignation,
    pieceIndice: input.pieceIndice,
    gammeCode: input.gammeCode,
    gammeVersion: input.gammeVersion,
    documentsAFournir: [...input.documentsAFournir],
    matiere: input.matiere,
    decoupe: { ...input.decoupe, longueurTotaleMm, methodeCalcul },
    sequenceMachines,
    sequenceMachinesLabel: formatMachineSequence(sequenceMachines),

    phases,
    totaux: {
      preparationH,
      fabricationH,
      finalH,
      preparationLabel: formatDuration(preparationH),
      fabricationLabel: formatDuration(fabricationH),
      finalLabel: formatDuration(finalH),
    },

    // Tri stable : les bloquants d'abord, puis par phase. L'ordre entre dans le
    // payload figé, donc dans le hash — il ne peut pas dépendre d'un parcours.
    avertissements: [...avertissements].sort((a, b) => {
      const rank = { BLOQUANT: 0, ATTENTION: 1, INFO: 2 } as const;
      if (rank[a.severite] !== rank[b.severite]) return rank[a.severite] - rank[b.severite];
      return (a.phase ?? -1) - (b.phase ?? -1) || a.code.localeCompare(b.code);
    }),
  };
}

/**
 * Filigrane exigé par l'état du document.
 *
 * Un brouillon ou une révision périmée qui ressemblerait à un document officiel
 * serait le pire défaut possible : quelqu'un fabriquerait d'après la mauvaise
 * gamme. Le filigrane n'est pas décoratif, il est la garantie de lecture.
 */
export function watermarkFor(args: {
  revisionStatut: string;
  documentStatut: string;
}): string | null {
  if (args.documentStatut === "BROUILLON") return "BROUILLON";
  if (args.documentStatut === "OBSOLETE" || args.revisionStatut === "OBSOLETE") return "OBSOLETE";
  return null;
}

/**
 * Empreinte du payload de document, calculée sur sa forme canonique.
 *
 * Distincte de `snapshotSha256` : celle-ci porte la DÉFINITION TECHNIQUE de la
 * révision, celle-là porte tout ce que le DOCUMENT affiche — y compris le
 * contexte commercial, les quantités, les VISA et la version de gabarit. Deux
 * documents d'une même révision peuvent donc différer légitimement, et l'écart
 * est alors visible sur cette empreinte et non sur celle de la révision.
 */
export function hashDocumentPayload(payload: OfDocumentPayload): string {
  return hashSnapshot(payload);
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
