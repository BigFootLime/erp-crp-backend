import crypto from "node:crypto";

type AddressSource = {
  name?: unknown;
  street?: unknown;
  house_number?: unknown;
  postal_code?: unknown;
  city?: unknown;
  country?: unknown;
};

type CommandeArFingerprintSource = {
  header: {
    numero: unknown;
    customer_reference: unknown;
    statut: unknown;
    date_commande: unknown;
    commentaire: unknown;
    total_ht: unknown;
    total_ttc: unknown;
    client_company_name: unknown;
    client_email: unknown;
    client_phone: unknown;
    bill_name?: unknown;
    bill_street?: unknown;
    bill_house_number?: unknown;
    bill_postal_code?: unknown;
    bill_city?: unknown;
    bill_country?: unknown;
    deliv_name?: unknown;
    deliv_street?: unknown;
    deliv_house_number?: unknown;
    deliv_postal_code?: unknown;
    deliv_city?: unknown;
    deliv_country?: unknown;
  };
  lines: Array<{
    designation: unknown;
    code_piece: unknown;
    quantite: unknown;
    unite: unknown;
    prix_unitaire_ht: unknown;
    taux_tva: unknown;
    total_ttc: unknown;
    delai_client?: unknown;
    delai_interne?: unknown;
  }>;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function sha256Canonical(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function normalizedAddress(source: AddressSource): Record<string, unknown> {
  return {
    name: source.name,
    street: source.street,
    house_number: source.house_number,
    postal_code: source.postal_code,
    city: source.city,
    country: source.country,
  };
}

function normalizedLine(source: Record<string, unknown>): Record<string, unknown> {
  return {
    designation: source.designation,
    code_piece: source.code_piece,
    quantite: source.quantite,
    unite: source.unite,
    prix_unitaire_ht: source.prix_unitaire_ht,
    taux_tva: source.taux_tva,
    total_ttc: source.total_ttc,
    delai_client: source.delai_client ?? null,
    delai_interne: source.delai_interne ?? null,
  };
}

/**
 * Snapshot of the customer-facing AR content only.
 *
 * Technical identifiers, allocation rows and update timestamps are deliberately
 * excluded: they are not rendered in the acknowledgement and must not make a
 * freshly generated document obsolete.
 */
export function buildCommandeArContentSnapshot(data: CommandeArFingerprintSource) {
  return {
    schema_version: 2,
    header: {
      numero: data.header.numero,
      customer_reference: data.header.customer_reference,
      statut: data.header.statut,
      date_commande: data.header.date_commande,
      commentaire: data.header.commentaire,
      total_ht: data.header.total_ht,
      total_ttc: data.header.total_ttc,
      client_company_name: data.header.client_company_name,
      client_email: data.header.client_email,
      client_phone: data.header.client_phone,
      bill_address: normalizedAddress({
        name: data.header.bill_name,
        street: data.header.bill_street,
        house_number: data.header.bill_house_number,
        postal_code: data.header.bill_postal_code,
        city: data.header.bill_city,
        country: data.header.bill_country,
      }),
      delivery_address: normalizedAddress({
        name: data.header.deliv_name,
        street: data.header.deliv_street,
        house_number: data.header.deliv_house_number,
        postal_code: data.header.deliv_postal_code,
        city: data.header.deliv_city,
        country: data.header.deliv_country,
      }),
    },
    lines: data.lines.map((line) => normalizedLine(line as Record<string, unknown>)),
  };
}

/** Normalizes both legacy v1 snapshots and current v2 snapshots for comparison. */
export function normalizeCommandeArContentSnapshot(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (!snapshot.header || typeof snapshot.header !== "object" || Array.isArray(snapshot.header) || !Array.isArray(snapshot.lines)) return null;
  const header = snapshot.header as Record<string, unknown>;
  const billAddress = header.bill_address && typeof header.bill_address === "object" && !Array.isArray(header.bill_address)
    ? header.bill_address as AddressSource
    : {};
  const deliveryAddress = header.delivery_address && typeof header.delivery_address === "object" && !Array.isArray(header.delivery_address)
    ? header.delivery_address as AddressSource
    : {};

  return {
    header: {
      numero: header.numero,
      customer_reference: header.customer_reference,
      statut: header.statut,
      date_commande: header.date_commande,
      commentaire: header.commentaire,
      total_ht: header.total_ht,
      total_ttc: header.total_ttc,
      client_company_name: header.client_company_name,
      client_email: header.client_email,
      client_phone: header.client_phone,
      bill_address: normalizedAddress(billAddress),
      delivery_address: normalizedAddress(deliveryAddress),
    },
    lines: snapshot.lines.map((line) => normalizedLine(
      line && typeof line === "object" && !Array.isArray(line) ? line as Record<string, unknown> : {}
    )),
  };
}

export function isCommandeArSnapshotCurrent(params: {
  storedSnapshot: unknown;
  storedFingerprint: string | null;
  currentSnapshot: unknown;
}): boolean {
  const currentNormalized = normalizeCommandeArContentSnapshot(params.currentSnapshot);
  const storedNormalized = normalizeCommandeArContentSnapshot(params.storedSnapshot);
  if (currentNormalized && storedNormalized) {
    return sha256Canonical(currentNormalized) === sha256Canonical(storedNormalized);
  }
  return Boolean(params.storedFingerprint) && params.storedFingerprint === sha256Canonical(params.currentSnapshot);
}
