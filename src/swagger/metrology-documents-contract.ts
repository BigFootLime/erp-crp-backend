const uuid = { type: "string", format: "uuid" };
const document = {
  type: "object",
  required: ["id", "kind", "label", "size_bytes", "sha256", "has_file", "scan_status", "created_at"],
  properties: {
    id: uuid,
    kind: { type: "string", enum: ["MD15_SCAN", "MAINTENANCE_SCAN", "NOTICE", "OTHER", "SOURCE_ARCHIVE"] },
    label: { type: "string" }, observed_on: { type: "string", format: "date", nullable: true },
    notes: { type: "string", nullable: true }, mime_type: { type: "string", nullable: true },
    size_bytes: { type: "integer", minimum: 0 }, sha256: { type: "string" },
    has_file: { type: "boolean", description: "Le téléchargement exige une analyse saine et la sortie de quarantaine." },
    scan_status: { type: "string", enum: ["PENDING", "CLEAN", "REJECTED", "UNKNOWN"] },
    created_at: { type: "string", format: "date-time" },
    created_by: { type: "object", nullable: true, properties: { id: { type: "integer" }, label: { type: "string" } } },
  },
};

export function metrologyDocumentsOperation(key: string, operation: Record<string, unknown>) {
  if (!/^(get|post) \/metrologie\/v2\/equipements\/\{id\}\/documents(?:\/\{docId\}\/file)?$/.test(key)) return operation;
  const write = key.startsWith("post ");
  const download = key.endsWith("/file");
  const parameters: unknown[] = [{ name: "id", in: "path", required: true, schema: uuid }];
  if (download) parameters.push({ name: "docId", in: "path", required: true, schema: uuid });
  else if (!write) parameters.push(
    { name: "page", in: "query", schema: { type: "integer", minimum: 1, maximum: 10000, default: 1 } },
    { name: "pageSize", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 200 } },
  );
  return {
    ...operation,
    summary: write ? "Ajouter un scan à un instrument" : download ? "Télécharger une pièce de l’instrument" : "Documents et scans de l’instrument",
    description: "Accès limité à l’instrument actif et au droit documentaire. Les documents repris et les nouveaux scans conservent leur provenance. Un scan ne qualifie pas l’instrument. Les fichiers en attente, rejetés ou en quarantaine ne sont pas téléchargeables.",
    parameters,
    ...(write ? { requestBody: { required: true, content: { "multipart/form-data": { schema: {
      type: "object", additionalProperties: false, required: ["file", "kind"], properties: {
        file: { type: "string", format: "binary", description: "PDF, JPEG ou PNG, 25 Mio au maximum ; signature et antivirus contrôlés côté serveur." },
        kind: { type: "string", enum: ["MD15_SCAN", "MAINTENANCE_SCAN", "NOTICE", "OTHER"] },
        label: { type: "string", minLength: 1, maxLength: 240 }, observed_on: { type: "string", format: "date", nullable: true },
        notes: { type: "string", maxLength: 5000, nullable: true },
      },
    } } } } } : {}),
    responses: {
      ...(operation.responses as Record<string, unknown>),
      [write ? "201" : "200"]: download ? {
        description: "Fichier autorisé, intègre et analysé ; audit avant livraison.",
        headers: { "X-CERP-Document-SHA256": { schema: { type: "string", pattern: "^[0-9a-f]{64}$" } } },
        content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
      } : { description: write ? "Scan reçu ; consulter scan_status avant téléchargement." : "Liste paginée de toutes les origines documentaires.",
        content: { "application/json": { schema: write ? document : {
          type: "object", required: ["items", "total", "page", "page_size", "has_more"], properties: {
            items: { type: "array", maxItems: 200, items: document }, total: { type: "integer" },
            page: { type: "integer" }, page_size: { type: "integer" }, has_more: { type: "boolean" },
          },
        } } },
      },
      "404": { description: "Instrument ou document introuvable dans ce périmètre." },
      "409": { description: "Analyse du document non validée ou intégrité non vérifiable." },
      "422": { description: "Identifiant, métadonnées ou pagination invalides." },
      ...(write ? { "413": { description: "Le scan dépasse 25 Mio." } } : {}),
    },
  };
}
