import { HttpError } from "../../../../../utils/httpError";
import type { ElectronicInvoiceSourceDocument } from "../../electronic-invoice.domain";

type JsonRecord = Record<string, unknown>;

const COUNTRY_CODES: Readonly<Record<string, string>> = {
  france: "FR",
  belgique: "BE",
  belgium: "BE",
  allemagne: "DE",
  germany: "DE",
  espagne: "ES",
  spain: "ES",
  italie: "IT",
  italy: "IT",
  suisse: "CH",
  switzerland: "CH",
  royaumeuni: "GB",
  unitedkingdom: "GB",
};

const UNIT_CODES: Readonly<Record<string, string>> = {
  u: "C62",
  unite: "C62",
  unites: "C62",
  unit: "C62",
  units: "C62",
  piece: "C62",
  pieces: "C62",
  pcs: "C62",
  h: "HUR",
  heure: "HUR",
  heures: "HUR",
  hour: "HUR",
  hours: "HUR",
  kg: "KGM",
  kilogramme: "KGM",
  kilogrammes: "KGM",
  g: "GRM",
  gramme: "GRM",
  grammes: "GRM",
  m: "MTR",
  metre: "MTR",
  metres: "MTR",
  mm: "MMT",
  millimetre: "MMT",
  millimetres: "MMT",
  lot: "SET",
  lots: "SET",
};

function normalizedLookupKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function record(value: unknown, field: string): Readonly<JsonRecord> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(422, "EINVOICE_EN16931_FIELD_INVALID", `Le champ ${field} est invalide.`);
  }
  return value as Readonly<JsonRecord>;
}

function requiredString(source: Readonly<JsonRecord>, key: string, field: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(422, "EINVOICE_EN16931_FIELD_MISSING", `Le champ ${field} est obligatoire.`);
  }
  return value.trim();
}

function optionalString(source: Readonly<JsonRecord>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeCountry(value: string, field: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  const mapped = COUNTRY_CODES[normalizedLookupKey(trimmed)];
  if (!mapped) {
    throw new HttpError(
      422,
      "EINVOICE_COUNTRY_CODE_REQUIRED",
      `Le pays ${field} doit être renseigné avec un code ISO 3166-1 alpha-2 reconnu.`
    );
  }
  return mapped;
}

function normalizeUnit(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(422, "EINVOICE_UNIT_REQUIRED", `L'unité ${field} est obligatoire.`);
  }
  const trimmed = value.trim();
  if (/^[A-Z0-9]{2,3}$/.test(trimmed)) return trimmed;
  const mapped = UNIT_CODES[normalizedLookupKey(trimmed)];
  if (!mapped) {
    throw new HttpError(
      422,
      "EINVOICE_UNIT_UNMAPPED",
      `L'unité ${field} n'a pas de correspondance UN/ECE configurée.`
    );
  }
  return mapped;
}

type Decimal = { coefficient: bigint; scale: number };

function decimal(value: unknown, field: string): Decimal {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    throw new HttpError(422, "EINVOICE_DECIMAL_INVALID", `La valeur numérique ${field} est invalide.`);
  }
  const normalized = value.trim();
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [integer = "0", fraction = ""] = unsigned.split(".");
  return {
    coefficient: BigInt(`${negative ? "-" : ""}${integer}${fraction}`),
    scale: fraction.length,
  };
}

function align(left: Decimal, right: Decimal): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * 10n ** BigInt(scale - left.scale),
    right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  ];
}

function add(left: Decimal, right: Decimal): Decimal {
  const [leftCoefficient, rightCoefficient, scale] = align(left, right);
  return { coefficient: leftCoefficient + rightCoefficient, scale };
}

function subtract(left: Decimal, right: Decimal): Decimal {
  const [leftCoefficient, rightCoefficient, scale] = align(left, right);
  return { coefficient: leftCoefficient - rightCoefficient, scale };
}

function formatDecimal(value: Decimal): string {
  const negative = value.coefficient < 0n;
  const absolute = negative ? -value.coefficient : value.coefficient;
  const padded = absolute.toString().padStart(value.scale + 1, "0");
  const integer = value.scale === 0 ? padded : padded.slice(0, -value.scale);
  const fraction = value.scale === 0 ? "" : padded.slice(-value.scale).replace(/0+$/, "");
  return `${negative ? "-" : ""}${integer}${fraction ? `.${fraction}` : ""}`;
}

function discountedUnitPrice(unitPrice: string, discountPercent: string | null, field: string): string {
  const price = decimal(unitPrice, `${field}.unit_price_ex_tax`);
  if (discountPercent === null) return formatDecimal(price);
  const discount = decimal(discountPercent, `${field}.discount_percent`);
  if (discount.coefficient < 0n) {
    throw new HttpError(422, "EINVOICE_DISCOUNT_INVALID", `La remise ${field} ne peut pas être négative.`);
  }
  const discountBase = 100n * 10n ** BigInt(discount.scale);
  if (discount.coefficient > discountBase) {
    throw new HttpError(422, "EINVOICE_DISCOUNT_INVALID", `La remise ${field} dépasse 100 %.`);
  }
  const numerator = price.coefficient * (discountBase - discount.coefficient);
  const outputScale = Math.max(price.scale, 6);
  const scaledNumerator = numerator * 10n ** BigInt(outputScale - price.scale);
  const rounded = (scaledNumerator + discountBase / 2n) / discountBase;
  return formatDecimal({ coefficient: rounded, scale: outputScale });
}

function postalAddress(source: Readonly<JsonRecord>, prefix: string): JsonRecord {
  const addressLine = requiredString(source, prefix === "seller" ? "address_line_1" : "street", `${prefix}.address_line_1`);
  const houseNumber = prefix === "buyer" ? optionalString(source, "house_number") : null;
  const complement = prefix === "buyer" ? optionalString(source, "address_complement") : null;
  return {
    address_line1: houseNumber ? `${houseNumber} ${addressLine}` : addressLine,
    ...(complement ? { address_line2: complement } : {}),
    post_code: requiredString(source, prefix === "seller" ? "postal_code" : "postal_code", `${prefix}.postal_code`),
    city: requiredString(source, "city", `${prefix}.city`),
    country_code: normalizeCountry(requiredString(source, "country", `${prefix}.country`), `${prefix}.country`),
  };
}

function partyAddressIdentifier(siret: string | null, siren: string | null, field: string) {
  if (siret && /^\d{14}$/.test(siret)) return { scheme: "0009", value: siret };
  if (siren && /^\d{9}$/.test(siren)) return { scheme: "0002", value: siren };
  throw new HttpError(422, "EINVOICE_PARTY_IDENTIFIER_REQUIRED", `L'identifiant ${field} est invalide.`);
}

function lineRecord(line: Readonly<JsonRecord>, index: number): {
  invoiceLine: JsonRecord;
  vatRate: string;
  net: Decimal;
  tax: Decimal;
} {
  const field = `lines[${index}]`;
  const quantity = requiredString(line, "quantity", `${field}.quantity`);
  const unitPrice = requiredString(line, "unit_price_ex_tax", `${field}.unit_price_ex_tax`);
  const net = decimal(requiredString(line, "total_ex_tax", `${field}.total_ex_tax`), `${field}.total_ex_tax`);
  const gross = decimal(requiredString(line, "total_incl_tax", `${field}.total_incl_tax`), `${field}.total_incl_tax`);
  const tax = subtract(gross, net);
  const vatRate = requiredString(line, "vat_rate", `${field}.vat_rate`);
  const parsedVatRate = decimal(vatRate, `${field}.vat_rate`);
  if (parsedVatRate.coefficient <= 0n) {
    throw new HttpError(
      422,
      "EINVOICE_VAT_CATEGORY_REQUIRED",
      `La catégorie et le motif de TVA doivent être qualifiés pour ${field} lorsque le taux est nul.`
    );
  }
  const discountPercent = optionalString(line, "discount_percent");
  const itemName = requiredString(line, "description", `${field}.description`);
  const itemCode = optionalString(line, "item_code");
  const invoiceLine: JsonRecord = {
    identifier: optionalString(line, "id") ?? String(index + 1),
    invoiced_quantity: formatDecimal(decimal(quantity, `${field}.quantity`)),
    invoiced_quantity_code: normalizeUnit(line.unit, `${field}.unit`),
    net_amount: formatDecimal(net),
    price_details: {
      item_net_price: discountedUnitPrice(unitPrice, discountPercent, field),
      item_price_base_quantity: "1",
      quantity_unit_code: normalizeUnit(line.unit, `${field}.unit`),
    },
    item_information: {
      name: itemName,
      ...(itemCode ? { seller_identifier: itemCode } : {}),
    },
    vat_information: {
      invoiced_item_vat_category_code: "S",
      invoiced_item_vat_rate: formatDecimal(parsedVatRate),
    },
    line_vat_amount: formatDecimal(tax),
    line_with_vat_net_amount: formatDecimal(gross),
  };
  return { invoiceLine, vatRate: formatDecimal(parsedVatRate), net, tax };
}

export function buildSuperPdpEn16931Invoice(source: ElectronicInvoiceSourceDocument): JsonRecord {
  if (source.documentType !== "INVOICE") {
    throw new HttpError(422, "EINVOICE_DOCUMENT_TYPE_UNSUPPORTED", "L'adaptateur SUPER PDP ne prépare ici que les factures.");
  }
  const issuer = record(source.issuerSnapshot, "issuer");
  const customer = record(source.customerSnapshot, "customer");
  const billingAddress = record(customer.billing_address, "customer.billing_address");
  const sellerSiren = requiredString(issuer, "siren", "issuer.siren").replace(/\s/g, "");
  const sellerSiret = optionalString(issuer, "siret")?.replace(/\s/g, "") ?? null;
  const buyerSiret = requiredString(customer, "siret", "customer.siret").replace(/\s/g, "");
  const sellerIdentifier = partyAddressIdentifier(sellerSiret, sellerSiren, "vendeur");
  const buyerIdentifier = partyAddressIdentifier(buyerSiret, null, "acheteur");
  const lineResults = source.lines.map((line, index) => lineRecord(record(line, `lines[${index}]`), index));
  const vatGroups = new Map<string, { net: Decimal; tax: Decimal }>();
  for (const result of lineResults) {
    const previous = vatGroups.get(result.vatRate) ?? { net: { coefficient: 0n, scale: 0 }, tax: { coefficient: 0n, scale: 0 } };
    vatGroups.set(result.vatRate, { net: add(previous.net, result.net), tax: add(previous.tax, result.tax) });
  }
  const currency = source.currency.toUpperCase();
  const iban = optionalString(issuer, "iban")?.replace(/\s/g, "") ?? null;
  const bic = optionalString(issuer, "bic")?.replace(/\s/g, "") ?? null;
  return {
    number: source.legalNumber,
    issue_date: source.issueDate,
    type_code: 380,
    currency_code: currency,
    process_control: { specification_identifier: "urn:cen.eu:en16931:2017" },
    seller: {
      name: requiredString(issuer, "company_name", "issuer.company_name"),
      electronic_address: sellerIdentifier,
      legal_registration_identifier: sellerIdentifier,
      vat_identifier: requiredString(issuer, "vat_number", "issuer.vat_number").replace(/\s/g, ""),
      postal_address: postalAddress(issuer, "seller"),
    },
    buyer: {
      name: requiredString(customer, "company_name", "customer.company_name"),
      electronic_address: buyerIdentifier,
      legal_registration_identifier: buyerIdentifier,
      ...(optionalString(customer, "vat_number") ? { vat_identifier: optionalString(customer, "vat_number")?.replace(/\s/g, "") } : {}),
      postal_address: postalAddress(billingAddress, "buyer"),
    },
    ...(source.dueDate ? { payment_due_date: source.dueDate } : {}),
    ...(iban ? {
      payment_instructions: {
        payment_means_type_code: "58",
        remittance_information: source.legalNumber,
        credit_transfers: [{
          payment_account_identifier: { scheme: "IBAN", value: iban },
          ...(bic ? { payment_service_provider_identifier: bic } : {}),
        }],
      },
    } : {}),
    totals: {
      sum_invoice_lines_amount: source.totals.net,
      total_without_vat: source.totals.net,
      total_vat_amount: { value: source.totals.tax, currency_code: currency },
      total_with_vat: source.totals.gross,
      amount_due_for_payment: source.totals.gross,
    },
    vat_break_down: [...vatGroups.entries()].map(([vatRate, totals]) => ({
      vat_category_taxable_amount: formatDecimal(totals.net),
      vat_category_tax_amount: formatDecimal(totals.tax),
      vat_category_code: "S",
      vat_category_rate: vatRate,
    })),
    lines: lineResults.map(({ invoiceLine }) => invoiceLine),
  };
}
