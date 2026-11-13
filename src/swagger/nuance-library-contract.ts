const standards = ["norme_fr", "norme_en", "norme_werkstoff", "norme_usa"];
const designation = { type: "string", maxLength: 40, nullable: true };
const json = (schema: Record<string, unknown>) => ({ "application/json": { schema } });
export function nuanceLibraryOperation(key: string, operation: Record<string, unknown>) {
  const create = key === "post /stock/matiere-nuances";
  const update = key === "patch /stock/matiere-nuances/{id}";
  if (!create && !update && key !== "get /stock/matiere-nuances") return operation;
  const properties = {
    ...Object.fromEntries(standards.map(name => [name, designation])),
    designation_principale: { type: "string", enum: ["FR", "EN", "WERKSTOFF", "USA", ...(update ? ["LEGACY"] : [])] },
    code: { type: "string", minLength: 1, maxLength: 40, description: "Code technique stable. Facultatif à la création, généré depuis la désignation principale ; conservé pour les liens articles." },
    designation: { type: "string", maxLength: 160, nullable: true },
    densite: { type: "number", minimum: 100, maximum: 30000, nullable: true, description: "kg/m³" },
    is_active: { type: "boolean" },
  };
  const row = { type: "object", required: ["id", "code", "libelle", "designation_principale", ...standards, "designation", "densite", "is_active", "etat_ids"], properties: {
    ...properties, id: { type: "integer", minimum: 1 }, libelle: { type: "string" },
    designation_principale: { type: "string", enum: ["FR", "EN", "WERKSTOFF", "USA", "LEGACY"] },
    etat_ids: { type: "array", items: { type: "integer", minimum: 1 } },
  } };
  const response = create || update ? row : { type: "object", required: ["items", "total"], properties: { items: { type: "array", items: row }, total: { type: "integer", minimum: 0 } } };
  return {
    ...operation,
    summary: create ? "Créer une nuance et ses correspondances" : update ? "Modifier une nuance et sa désignation principale" : "Rechercher dans la bibliothèque des nuances",
    description: "Au moins une norme pour toute nouvelle nuance. Le titre doit désigner une norme renseignée. Les identifiants, liens articles et codes historiques sont conservés ; LEGACY signifie à classer, sans norme déduite. Les doublons normalisés dans une norme sont interdits, y compris parmi les entrées inactives. Le rapprochement d’un code historique est contrôlé avant toute création. Aucune équivalence métallurgique automatique.",
    ...(create || update ? { requestBody: { required: true, content: json({ type: "object", additionalProperties: false,
      properties: { ...properties, ...(create ? { etat_ids: { type: "array", items: { type: "integer", minimum: 1 } } } : {}) },
      ...(create ? { anyOf: standards.map(field => ({ required: [field], properties: { [field]: { type: "string", minLength: 1, maxLength: 40 } } })) } : { minProperties: 1 }),
    }) } } : { parameters: [
      { name: "q", in: "query", schema: { type: "string" }, description: "Code, description ou l’une des quatre désignations." },
      { name: "etat_id", in: "query", schema: { type: "integer", minimum: 1 } },
      { name: "is_active", in: "query", schema: { type: "boolean" } },
    ] }),
    responses: {
      ...(operation.responses as Record<string, unknown>),
      [create ? "201" : "200"]: { description: create ? "Nuance créée et auditée atomiquement." : "Bibliothèque ou nuance mise à jour.", content: json(response) },
      "400": { description: "Norme manquante, titre non renseigné, densité invalide ou modification du code technique d’une nuance classée." },
      "409": { description: "Une désignation ou un code normalisé appartient déjà à une nuance, active ou inactive." },
    },
  };
}
