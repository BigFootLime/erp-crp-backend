import crypto from "node:crypto";

import { HttpError } from "../../utils/httpError";
import { canonicalJson } from "../facturation/domain/finance-policy";
import { divideHalfUp, formatDecimal, moneyToCents, parseDecimal } from "../facturation/domain/decimal-money";

export const ACCOUNTING_EXPORT_ADAPTER = "GENERIC_DELIMITED_V1" as const;
export const ACCOUNTING_SOURCE_TYPES = ["INVOICE", "CREDIT_NOTE", "PAYMENT", "SUPPLIER_INVOICE", "SUPPLIER_CREDIT_NOTE"] as const;
export type AccountingSourceType = (typeof ACCOUNTING_SOURCE_TYPES)[number];

export type AccountingMappingConfig = {
  delimiter: ";" | "," | "\t";
  sales_journal: string;
  credit_journal: string;
  bank_journal_by_mode: Record<string, string>;
  bank_account_by_mode: Record<string, string>;
  default_bank_journal: string | null;
  default_bank_account: string | null;
  sales_account_by_tax: Record<string, string>;
  vat_output_account_by_tax: Record<string, string>;
  purchase_journal?: string | null;
  supplier_credit_journal?: string | null;
  purchase_account_by_tax_category?: Record<string, string>;
  vat_input_account_by_tax_category?: Record<string, string>;
  reverse_charge_output_account_by_tax_category?: Record<string, string>;
  self_assessed_vat_rate_by_tax_category?: Record<string, string>;
  fx_gain_account?: string | null;
  fx_loss_account?: string | null;
  default_axes: Record<string, string>;
};

export type AccountingSourceDocument = {
  source_type: AccountingSourceType;
  source_id: string;
  source_number: string;
  source_updated_at: string;
  entry_date: string;
  client_id: string;
  third_party_account: string | null;
  currency: string;
  payment_mode: string | null;
  total_ex_tax: string;
  total_tax: string;
  total_incl_tax: string;
  tax_breakdown: Array<{ tax_rate: string; tax_category?: string | null; total_ex_tax: string; tax_amount: string }>;
  partner_country_code?: string | null;
  claimed_batch_id: string | null;
};

export type AccountingEntryLine = {
  line_no: number;
  source_type: AccountingSourceType;
  source_id: string;
  source_number: string;
  source_updated_at: string;
  entry_date: string;
  journal_code: string;
  account_number: string;
  third_party_account: string | null;
  label: string;
  piece_reference: string;
  currency: string;
  debit: string;
  credit: string;
  tax_rate: string | null;
  axes: Record<string, string>;
};

export type AccountingFinding = {
  severity: "BLOCKER" | "WARNING";
  code: string;
  message: string;
  source_type?: AccountingSourceType;
  source_id?: string;
};

export type AccountingPreview = {
  lines: AccountingEntryLine[];
  findings: AccountingFinding[];
  source_count: number;
  currency_totals: Array<{ currency: string; debit: string; credit: string; balanced: boolean }>;
  source_sha256: string;
  lines_sha256: string;
};

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function normalizeTaxRate(value: string): string {
  return formatDecimal(parseDecimal(value, 4, "Taux de TVA"), 4);
}

function mappingValue(map: Record<string, string>, key: string): string | null {
  const direct = map[key];
  if (direct?.trim()) return direct.trim();
  const normalized = normalizeTaxRate(key);
  const found = Object.entries(map).find(([candidate]) => normalizeTaxRate(candidate) === normalized);
  return found?.[1]?.trim() || null;
}

function supplierMappingValue(map: Record<string, string> | undefined, category: string, rate: string): string | null {
  if (!map) return null;
  const exactKey = `${category}:${normalizeTaxRate(rate)}`;
  const direct = map[exactKey] ?? map[`${category}:${Number(normalizeTaxRate(rate))}`];
  return direct?.trim() || null;
}

function validateSourceTotals(source: AccountingSourceDocument): AccountingFinding[] {
  const findings: AccountingFinding[] = [];
  const exTax = moneyToCents(source.total_ex_tax, "Total HT");
  const tax = moneyToCents(source.total_tax, "Total TVA");
  const inclTax = moneyToCents(source.total_incl_tax, "Total TTC");
  if (source.source_type === "PAYMENT") {
    if (inclTax <= 0n) {
      findings.push({
        severity: "BLOCKER",
        code: "ACCOUNTING_PAYMENT_AMOUNT_INVALID",
        message: `${source.source_number}: le montant du paiement doit être positif.`,
        source_type: source.source_type,
        source_id: source.source_id,
      });
    }
    return findings;
  }
  if (exTax + tax !== inclTax) {
    findings.push({
      severity: "BLOCKER",
      code: "ACCOUNTING_SOURCE_TOTAL_MISMATCH",
      message: `${source.source_number}: HT + TVA ne correspond pas au TTC.`,
      source_type: source.source_type,
      source_id: source.source_id,
    });
  }
  const breakdownExTax = source.tax_breakdown.reduce(
    (sum, item) => sum + moneyToCents(item.total_ex_tax, "Base TVA"),
    0n
  );
  const breakdownTax = source.tax_breakdown.reduce(
    (sum, item) => sum + moneyToCents(item.tax_amount, "Montant TVA"),
    0n
  );
  if (breakdownExTax !== exTax || breakdownTax !== tax) {
    findings.push({
      severity: "BLOCKER",
      code: "ACCOUNTING_TAX_BREAKDOWN_MISMATCH",
      message: `${source.source_number}: la ventilation TVA ne correspond pas aux totaux du document.`,
      source_type: source.source_type,
      source_id: source.source_id,
    });
  }
  return findings;
}

function sourceLines(
  source: AccountingSourceDocument,
  mapping: AccountingMappingConfig,
  firstLine: number
): { lines: AccountingEntryLine[]; findings: AccountingFinding[] } {
  const findings = validateSourceTotals(source);
  if (source.claimed_batch_id) {
    findings.push({
      severity: "BLOCKER",
      code: "ACCOUNTING_SOURCE_ALREADY_EXPORTED",
      message: `${source.source_number}: déjà réservé par le lot ${source.claimed_batch_id}.`,
      source_type: source.source_type,
      source_id: source.source_id,
    });
  }
  if (!source.third_party_account?.trim()) {
    findings.push({
      severity: "BLOCKER",
      code: "ACCOUNTING_THIRD_PARTY_ACCOUNT_MISSING",
        message: `${source.source_number}: compte tiers client ou fournisseur manquant.`,
      source_type: source.source_type,
      source_id: source.source_id,
    });
  }
  if (!/^[A-Z]{3}$/.test(source.currency)) {
    findings.push({
      severity: "BLOCKER",
      code: "ACCOUNTING_CURRENCY_INVALID",
      message: `${source.source_number}: devise ISO 4217 invalide.`,
      source_type: source.source_type,
      source_id: source.source_id,
    });
  }
  const common = {
    source_type: source.source_type,
    source_id: source.source_id,
    source_number: source.source_number,
    source_updated_at: source.source_updated_at,
    entry_date: source.entry_date,
    third_party_account: source.third_party_account?.trim() || null,
    label: source.source_number,
    piece_reference: source.source_number,
    currency: source.currency,
    axes: mapping.default_axes,
  };
  const lines: AccountingEntryLine[] = [];
  const push = (line: Omit<AccountingEntryLine, "line_no">) => lines.push({ ...line, line_no: firstLine + lines.length });

  if (source.source_type === "PAYMENT") {
    const mode = source.payment_mode?.trim() || "DEFAULT";
    const journal = mapping.bank_journal_by_mode[mode] ?? mapping.default_bank_journal;
    const bankAccount = mapping.bank_account_by_mode[mode] ?? mapping.default_bank_account;
    if (!journal || !bankAccount) {
      findings.push({
        severity: "BLOCKER",
        code: "ACCOUNTING_PAYMENT_MAPPING_MISSING",
        message: `${source.source_number}: journal ou compte bancaire absent pour le mode ${mode}.`,
        source_type: source.source_type,
        source_id: source.source_id,
      });
      return { lines, findings };
    }
    push({ ...common, journal_code: journal, account_number: bankAccount, third_party_account: null, debit: source.total_incl_tax, credit: "0.00", tax_rate: null });
    push({ ...common, journal_code: journal, account_number: source.third_party_account ?? "", debit: "0.00", credit: source.total_incl_tax, tax_rate: null });
    return { lines, findings };
  }

  const isSupplier = source.source_type === "SUPPLIER_INVOICE" || source.source_type === "SUPPLIER_CREDIT_NOTE";
  if (isSupplier) {
    const isCredit = source.source_type === "SUPPLIER_CREDIT_NOTE";
    const journal = isCredit ? mapping.supplier_credit_journal : mapping.purchase_journal;
    if (!journal) {
      findings.push({
        severity: "BLOCKER",
        code: "ACCOUNTING_PURCHASE_JOURNAL_MISSING",
        message: `${source.source_number}: journal d'achat fournisseur absent du mapping validé.`,
        source_type: source.source_type,
        source_id: source.source_id,
      });
      return { lines, findings };
    }
    push({
      ...common,
      journal_code: journal,
      account_number: source.third_party_account ?? "",
      debit: isCredit ? source.total_incl_tax : "0.00",
      credit: isCredit ? "0.00" : source.total_incl_tax,
      tax_rate: null,
    });
    for (const tax of source.tax_breakdown) {
      const rate = normalizeTaxRate(tax.tax_rate);
      const category = tax.tax_category?.trim().toUpperCase() ?? "";
      if (!/^[A-Z]{1,3}$/.test(category)) {
        findings.push({ severity: "BLOCKER", code: "ACCOUNTING_PURCHASE_TAX_CATEGORY_MISSING", message: `${source.source_number}: catégorie fiscale EN16931 absente pour le taux ${rate}.`, source_type: source.source_type, source_id: source.source_id });
        continue;
      }
      const purchaseAccount = supplierMappingValue(mapping.purchase_account_by_tax_category, category, rate);
      if (!purchaseAccount) {
        findings.push({ severity: "BLOCKER", code: "ACCOUNTING_PURCHASE_ACCOUNT_MISSING", message: `${source.source_number}: compte de charge/stock absent pour ${category}:${rate}.`, source_type: source.source_type, source_id: source.source_id });
      } else {
        push({ ...common, journal_code: journal, account_number: purchaseAccount, third_party_account: null, debit: isCredit ? "0.00" : tax.total_ex_tax, credit: isCredit ? tax.total_ex_tax : "0.00", tax_rate: rate });
      }
      const sourceTaxCents = moneyToCents(tax.tax_amount, "Montant TVA achat");
      const vatInputAccount = supplierMappingValue(mapping.vat_input_account_by_tax_category, category, rate);
      if (sourceTaxCents !== 0n) {
        if (!vatInputAccount) {
          findings.push({ severity: "BLOCKER", code: "ACCOUNTING_VAT_INPUT_ACCOUNT_MISSING", message: `${source.source_number}: compte de TVA déductible absent pour ${category}:${rate}.`, source_type: source.source_type, source_id: source.source_id });
        } else {
          push({ ...common, journal_code: journal, account_number: vatInputAccount, third_party_account: null, debit: isCredit ? "0.00" : tax.tax_amount, credit: isCredit ? tax.tax_amount : "0.00", tax_rate: rate });
        }
      }
      if (category === "K" || category === "AE") {
        const selfAssessedRate = supplierMappingValue(mapping.self_assessed_vat_rate_by_tax_category, category, rate);
        const outputAccount = supplierMappingValue(mapping.reverse_charge_output_account_by_tax_category, category, rate);
        if (!selfAssessedRate || !vatInputAccount || !outputAccount) {
          findings.push({
            severity: "BLOCKER",
            code: "ACCOUNTING_REVERSE_CHARGE_MAPPING_MISSING",
            message: `${source.source_number}: taux français et comptes d'autoliquidation incomplets pour ${category}:${rate}.`,
            source_type: source.source_type,
            source_id: source.source_id,
          });
          continue;
        }
        const rateUnits = parseDecimal(selfAssessedRate, 4, "Taux d'autoliquidation");
        if (rateUnits <= 0n || rateUnits > 1_000_000n) {
          findings.push({ severity: "BLOCKER", code: "ACCOUNTING_REVERSE_CHARGE_RATE_INVALID", message: `${source.source_number}: taux d'autoliquidation hors limites pour ${category}:${rate}.`, source_type: source.source_type, source_id: source.source_id });
          continue;
        }
        const selfTaxCents = divideHalfUp(moneyToCents(tax.total_ex_tax, "Base autoliquidation") * rateUnits, 1_000_000n);
        const selfTax = formatDecimal(selfTaxCents, 2);
        push({ ...common, journal_code: journal, account_number: vatInputAccount, third_party_account: null, debit: isCredit ? "0.00" : selfTax, credit: isCredit ? selfTax : "0.00", tax_rate: selfAssessedRate });
        push({ ...common, journal_code: journal, account_number: outputAccount, third_party_account: null, debit: isCredit ? selfTax : "0.00", credit: isCredit ? "0.00" : selfTax, tax_rate: selfAssessedRate });
      }
    }
    if (source.currency !== "EUR" && (!mapping.fx_gain_account || !mapping.fx_loss_account)) {
      findings.push({ severity: "WARNING", code: "ACCOUNTING_FX_ACCOUNTS_MISSING", message: `${source.source_number}: comptes d'écart de change non configurés; le règlement devra être traité dans le logiciel du cabinet.`, source_type: source.source_type, source_id: source.source_id });
    }
    return { lines, findings };
  }

  const isCredit = source.source_type === "CREDIT_NOTE";
  const journal = isCredit ? mapping.credit_journal : mapping.sales_journal;
  push({
    ...common,
    journal_code: journal,
    account_number: source.third_party_account ?? "",
    debit: isCredit ? "0.00" : source.total_incl_tax,
    credit: isCredit ? source.total_incl_tax : "0.00",
    tax_rate: null,
  });
  for (const tax of source.tax_breakdown) {
    const rate = normalizeTaxRate(tax.tax_rate);
    const salesAccount = mappingValue(mapping.sales_account_by_tax, rate);
    const vatAccount = mappingValue(mapping.vat_output_account_by_tax, rate);
    if (!salesAccount) {
      findings.push({ severity: "BLOCKER", code: "ACCOUNTING_SALES_ACCOUNT_MISSING", message: `${source.source_number}: compte de vente absent pour TVA ${rate}.`, source_type: source.source_type, source_id: source.source_id });
    } else {
      push({ ...common, journal_code: journal, account_number: salesAccount, third_party_account: null, debit: isCredit ? tax.total_ex_tax : "0.00", credit: isCredit ? "0.00" : tax.total_ex_tax, tax_rate: rate });
    }
    if (moneyToCents(tax.tax_amount, "Montant TVA") !== 0n) {
      if (!vatAccount) {
        findings.push({ severity: "BLOCKER", code: "ACCOUNTING_VAT_ACCOUNT_MISSING", message: `${source.source_number}: compte de TVA absent pour le taux ${rate}.`, source_type: source.source_type, source_id: source.source_id });
      } else {
        push({ ...common, journal_code: journal, account_number: vatAccount, third_party_account: null, debit: isCredit ? tax.tax_amount : "0.00", credit: isCredit ? "0.00" : tax.tax_amount, tax_rate: rate });
      }
    }
  }
  return { lines, findings };
}

export function buildAccountingPreview(
  sources: readonly AccountingSourceDocument[],
  mapping: AccountingMappingConfig
): AccountingPreview {
  const lines: AccountingEntryLine[] = [];
  const findings: AccountingFinding[] = [];
  for (const source of [...sources].sort((a, b) =>
    `${a.entry_date}:${a.source_type}:${a.source_number}:${a.source_id}`.localeCompare(
      `${b.entry_date}:${b.source_type}:${b.source_number}:${b.source_id}`
    )
  )) {
    const built = sourceLines(source, mapping, lines.length + 1);
    lines.push(...built.lines);
    findings.push(...built.findings);
  }
  const totals = new Map<string, { debit: bigint; credit: bigint }>();
  for (const line of lines) {
    const current = totals.get(line.currency) ?? { debit: 0n, credit: 0n };
    current.debit += moneyToCents(line.debit, "Débit");
    current.credit += moneyToCents(line.credit, "Crédit");
    totals.set(line.currency, current);
    if ((moneyToCents(line.debit, "Débit") === 0n) === (moneyToCents(line.credit, "Crédit") === 0n)) {
      findings.push({ severity: "BLOCKER", code: "ACCOUNTING_LINE_SIDE_INVALID", message: `Ligne ${line.line_no}: un seul côté débit/crédit doit être renseigné.`, source_type: line.source_type, source_id: line.source_id });
    }
  }
  const currencyTotals = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, total]) => ({
    currency,
    debit: formatDecimal(total.debit, 2),
    credit: formatDecimal(total.credit, 2),
    balanced: total.debit === total.credit,
  }));
  for (const total of currencyTotals) {
    if (!total.balanced) findings.push({ severity: "BLOCKER", code: "ACCOUNTING_BATCH_UNBALANCED", message: `Le lot n'est pas équilibré en ${total.currency}: débit ${total.debit}, crédit ${total.credit}.` });
  }
  if (sources.length === 0) findings.push({ severity: "BLOCKER", code: "ACCOUNTING_SOURCE_EMPTY", message: "Aucune pièce comptable éligible sur la période." });
  return {
    lines,
    findings,
    source_count: sources.length,
    currency_totals: currencyTotals,
    source_sha256: sha256(sources),
    lines_sha256: sha256(lines),
  };
}

function csvCell(value: string, delimiter: string): string {
  const escaped = value.replace(/"/g, '""');
  return escaped.includes(delimiter) || /["\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

export interface AccountingExportAdapter {
  readonly code: typeof ACCOUNTING_EXPORT_ADAPTER;
  render(lines: readonly AccountingEntryLine[], mapping: AccountingMappingConfig): Buffer;
}

export class GenericDelimitedV1Adapter implements AccountingExportAdapter {
  readonly code = ACCOUNTING_EXPORT_ADAPTER;

  render(lines: readonly AccountingEntryLine[], mapping: AccountingMappingConfig): Buffer {
    const columns = ["JournalCode", "EcritureDate", "PieceRef", "CompteNum", "CompteAuxNum", "EcritureLib", "Debit", "Credit", "Devise", "TaxRate", "Axes"];
    const rows = lines.map((line) => [
      line.journal_code, line.entry_date, line.piece_reference, line.account_number,
      line.third_party_account ?? "", line.label, line.debit, line.credit,
      line.currency, line.tax_rate ?? "", canonicalJson(line.axes),
    ].map((cell) => csvCell(cell, mapping.delimiter)).join(mapping.delimiter));
    return Buffer.from(`\uFEFF${[columns.join(mapping.delimiter), ...rows].join("\r\n")}\r\n`, "utf8");
  }
}

export function assertPreviewCanAdvance(preview: AccountingPreview): void {
  const blockers = preview.findings.filter((finding) => finding.severity === "BLOCKER");
  if (blockers.length > 0) {
    throw new HttpError(422, "ACCOUNTING_EXPORT_BLOCKED", "Le lot comptable est incomplet ou déséquilibré.", { blockers });
  }
}
