import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolConnect: vi.fn(),
  poolQuery: vi.fn(),
  clientRelease: vi.fn(),
  generateCommandeCode: vi.fn(),
  generateSupplierCode: vi.fn(),
  insertAudit: vi.fn(),
  issuer: vi.fn(),
}));

vi.mock("../config/database", () => ({
  default: { connect: mocks.poolConnect, query: mocks.poolQuery },
}));

vi.mock("../shared/codes/code-generator.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/codes/code-generator.service")>();
  return {
    ...actual,
    generateCommandeCode: mocks.generateCommandeCode,
    generateCommandeFournisseurCode: mocks.generateSupplierCode,
  };
});

vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: mocks.insertAudit,
}));

vi.mock("../shared/documents/issuer-identity.repository", () => ({
  readIssuerParty: mocks.issuer,
}));

import { repoDuplicateCommande } from "../module/commande-client/repository/commande-client.repository";
import { repoConfirmPropositions } from "../module/commande-fournisseur/repository/commande-fournisseur.repository";
import { authoritativePdfQueueDbMock } from "./helpers/authoritative-pdf-queue-db-mock";

type QueryResult = { rows: Record<string, unknown>[]; rowCount?: number };

const CUSTOMER_ORDER_ID = "456";
const SUPPLIER_ID = "11111111-1111-4111-8111-111111111111";
const SUPPLIER_ORDER_ID = "22222222-2222-4222-8222-222222222222";
const SUPPLIER_LINE_ID = "33333333-3333-4333-8333-333333333333";

/**
 * Extends the shared authoritative queue fixture with transaction-local state.
 * An archive insert is deliberately kept pending until COMMIT, so an outbox
 * failure proves that the business caller's rollback discards it.
 */
function transactionalAuthoritativeQueue(options: { failOutbox?: boolean } = {}) {
  const calls: Array<{ statement: string; values: readonly unknown[] }> = [];
  const pendingArchives = new Map<string, Record<string, unknown>>();
  const pendingOutbox = new Set<string>();
  const committedArchives = new Map<string, Record<string, unknown>>();
  const committedOutbox = new Set<string>();

  const handle = (sql: unknown, values: readonly unknown[] = []): QueryResult | undefined => {
    const statement = String(sql);
    calls.push({ statement, values });
    if (statement === "BEGIN") return { rows: [] };
    if (statement === "ROLLBACK") {
      pendingArchives.clear();
      pendingOutbox.clear();
      return { rows: [] };
    }
    if (statement === "COMMIT") {
      for (const [key, row] of pendingArchives) committedArchives.set(key, row);
      for (const key of pendingOutbox) committedOutbox.add(key);
      pendingArchives.clear();
      pendingOutbox.clear();
      return { rows: [] };
    }
    if (statement.includes("INSERT INTO public.authoritative_pdf_archives")) {
      const result = authoritativePdfQueueDbMock(sql, values);
      const key = String(values[5]);
      const row = result?.rows[0];
      if (!row) throw new Error("test queue fixture did not return an archive row");
      pendingArchives.set(key, row);
      return result;
    }
    if (statement.includes("INSERT INTO public.authoritative_pdf_archive_outbox")) {
      if (options.failOutbox) throw new Error("authoritative outbox unavailable");
      const result = authoritativePdfQueueDbMock(sql, values);
      pendingOutbox.add(String(values[1]));
      return result ?? { rows: [], rowCount: 1 };
    }
    return undefined;
  };

  return { calls, committedArchives, committedOutbox, handle };
}

const originalCommande = {
  numero: "CC-123",
  client_id: "001",
  contact_id: null,
  destinataire_id: null,
  adresse_facturation_id: null,
  emetteur: null,
  code_client: "ACME",
  compteur_affaire_id: null,
  type_affaire: "livraison",
  order_type: "FERME",
  cadre_start_date: null,
  cadre_end_date: null,
  dest_stock_magasin_id: null,
  dest_stock_emplacement_id: null,
  mode_port_id: null,
  mode_reglement_id: null,
  conditions_paiement_id: null,
  biller_id: null,
  compte_vente_id: null,
  commentaire: null,
  remise_globale: 0,
  total_ht: 0,
  total_ttc: 0,
};

function customerDuplicateDispatcher(queue: ReturnType<typeof transactionalAuthoritativeQueue>) {
  return async (sql: unknown, values: readonly unknown[] = []): Promise<QueryResult> => {
    const queued = queue.handle(sql, values);
    if (queued) return queued;

    const shared = authoritativePdfQueueDbMock(sql, values);
    if (shared) return shared;

    const statement = String(sql);
    if (statement.includes("FROM commande_client") && statement.includes("WHERE id = $1") && statement.includes("FOR UPDATE")) {
      return { rows: [originalCommande] };
    }
    if (statement.includes("FROM commande_ligne") && statement.includes("WHERE commande_id = $1")) {
      return { rows: [] };
    }
    if (statement.includes("nextval('public.commande_client_id_seq')")) {
      return { rows: [{ id: CUSTOMER_ORDER_ID }] };
    }
    return { rows: [] };
  };
}

type SupplierReplayState = { resultat: Record<string, unknown> | null };

function supplierProposalDispatcher(
  queue: ReturnType<typeof transactionalAuthoritativeQueue>,
  replay: SupplierReplayState,
) {
  return async (sql: unknown, values: readonly unknown[] = []): Promise<QueryResult> => {
    const queued = queue.handle(sql, values);
    if (queued) return queued;

    const statement = String(sql);
    if (statement.includes("FROM public.commande_fournisseur_idempotence")) {
      return replay.resultat
        ? { rows: [{ action: "GENERATE", resultat: replay.resultat }] }
        : { rows: [] };
    }
    if (statement.includes("INSERT INTO public.commande_fournisseur_idempotence")) {
      replay.resultat = JSON.parse(String(values[3])) as Record<string, unknown>;
      return { rows: [] };
    }
    if (statement.includes("FROM public.commande_fournisseur cf") && statement.includes("JOIN public.fournisseurs f")) {
      return {
        rows: [{
          code: "BCF-2026-0042", statut: "BROUILLON", issued_at: "2026-08-23T12:00:00.000Z", devise: "EUR",
          need_date: null, incoterm: null, payment_terms: null, transport_mode: null, public_comment: null,
          delivery_address: null, supplier_code: "FOU-001", supplier_name: "Fournisseur test",
          supplier_street: null, supplier_house_no: null, supplier_postal_code: null, supplier_city: null, supplier_country: null,
          total_ht: "20", total_remise: "0", total_tva: "4", freight_ht: "0", total_ttc: "24",
        }],
      };
    }
    if (statement.includes("SELECT position::int") && statement.includes("FROM public.commande_fournisseur_ligne") && statement.includes("statut_ligne = 'ACTIVE'")) {
      return { rows: [{ position: 1, reference: null, designation: "Article test", unit: "u", quantity: "10", unit_price_ht: "2", discount_pct: "0", vat_pct: "20", net_ht: "20", need_date: null }] };
    }
    if (statement.includes("SELECT updated_at::text AS source_revision") && statement.includes("FROM public.commande_fournisseur")) {
      return { rows: [{ source_revision: "2026-08-23T12:00:00.000Z" }] };
    }
    if (statement.includes("SELECT id, COALESCE(code, code_fournisseur)") && statement.includes("FROM public.fournisseurs")) {
      return { rows: [{ id: SUPPLIER_ID, code: "FOU-001", nom: "Fournisseur test", status: "actif", actif: true }] };
    }
    if (
      statement.includes("INSERT INTO public.commande_fournisseur") &&
      !statement.includes("commande_fournisseur_ligne") &&
      !statement.includes("commande_fournisseur_idempotence")
    ) {
      return { rows: [{ id: SUPPLIER_ORDER_ID }] };
    }
    if (statement.includes("INSERT INTO public.commande_fournisseur_ligne_besoin")) {
      return { rows: [] };
    }
    if (statement.includes("INSERT INTO public.commande_fournisseur_ligne (") && !statement.includes("ligne_besoin")) {
      return { rows: [{ id: SUPPLIER_LINE_ID }] };
    }
    if (statement.includes("SELECT quantite::text") && statement.includes("FROM public.commande_fournisseur_ligne")) {
      return { rows: [{ quantite: "10", prix_unitaire_ht: "2", remise_pct: "0", tva_pct: "20", frais_ht: "0", statut_ligne: "ACTIVE" }] };
    }
    if (statement.includes("SELECT frais_port_ht::text") && statement.includes("FROM public.commande_fournisseur")) {
      return { rows: [{ frais_port_ht: "0", tva_frais_pct: "20" }] };
    }
    return { rows: [] };
  };
}

const supplierAudit = {
  user_id: 7,
  ip: "127.0.0.1",
  user_agent: "vitest",
  device_type: null,
  os: null,
  browser: null,
  path: "/api/v1/commandes-fournisseurs/propositions/confirm",
  page_key: "commandes-fournisseurs",
  client_session_id: "creation-snapshot-transaction-test",
};

const supplierProposalBody = {
  idempotency_key: "supplier-proposal-creation-42",
  groupes: [{
    fournisseur_id: SUPPLIER_ID,
    devise: "EUR",
    date_besoin: null,
    lignes: [{
      besoin_type: "STOCK_LEVEL",
      besoin_ref: "stock-level-42",
      of_id: null,
      article_id: null,
      catalogue_id: null,
      type: "ARTICLE",
      designation: "Article test",
      quantite: 10,
      unite: "u",
      prix_unitaire_ht: 2,
      tva_pct: 20,
      date_besoin: null,
      delai_jours: null,
    }],
  }],
};

function indices(state: ReturnType<typeof transactionalAuthoritativeQueue>) {
  return {
    begin: state.calls.findIndex(({ statement }) => statement === "BEGIN"),
    archive: state.calls.findIndex(({ statement }) => statement.includes("INSERT INTO public.authoritative_pdf_archives")),
    outbox: state.calls.findIndex(({ statement }) => statement.includes("INSERT INTO public.authoritative_pdf_archive_outbox")),
    commit: state.calls.findIndex(({ statement }) => statement === "COMMIT"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.poolConnect.mockReset();
  mocks.poolQuery.mockReset();
  mocks.clientRelease.mockReset();
  mocks.generateCommandeCode.mockResolvedValue("CMD-2026-0456");
  mocks.generateSupplierCode.mockResolvedValue("BCF-2026-0042");
  mocks.insertAudit.mockResolvedValue(undefined);
  mocks.issuer.mockResolvedValue({ company_name: "CERP Test" });
  mocks.poolQuery.mockResolvedValue({ rows: [] });
});

describe("automatic creation snapshot queue transactions", () => {
  it("rolls back a failed customer-order duplicate queue and commits exactly one archive/outbox on retry", async () => {
    const failedQueue = transactionalAuthoritativeQueue({ failOutbox: true });
    mocks.poolConnect.mockResolvedValueOnce({
      query: vi.fn(customerDuplicateDispatcher(failedQueue)),
      release: mocks.clientRelease,
    });

    await expect(repoDuplicateCommande("123")).rejects.toThrow("authoritative outbox unavailable");
    expect(failedQueue.committedArchives.size).toBe(0);
    expect(failedQueue.committedOutbox.size).toBe(0);
    expect(failedQueue.calls.some(({ statement }) => statement === "ROLLBACK")).toBe(true);
    expect(failedQueue.calls.some(({ statement }) => statement === "COMMIT")).toBe(false);

    const successfulQueue = transactionalAuthoritativeQueue();
    mocks.poolConnect.mockResolvedValueOnce({
      query: vi.fn(customerDuplicateDispatcher(successfulQueue)),
      release: mocks.clientRelease,
    });

    await expect(repoDuplicateCommande("123")).resolves.toEqual({ id: Number(CUSTOMER_ORDER_ID) });
    expect([...successfulQueue.committedArchives.keys()]).toEqual([`commande-client:${CUSTOMER_ORDER_ID}:creation:v1`]);
    expect([...successfulQueue.committedOutbox]).toEqual([`authoritative-pdf:commande-client:${CUSTOMER_ORDER_ID}:creation:v1`]);
    expect(successfulQueue.calls.filter(({ statement }) => statement.includes("INSERT INTO public.authoritative_pdf_archives"))).toHaveLength(1);
    expect(successfulQueue.calls.filter(({ statement }) => statement.includes("INSERT INTO public.authoritative_pdf_archive_outbox"))).toHaveLength(1);
    expect(indices(successfulQueue)).toMatchObject({ begin: 0 });
    const order = indices(successfulQueue);
    expect(order.begin).toBeLessThan(order.archive);
    expect(order.archive).toBeLessThan(order.outbox);
    expect(order.outbox).toBeLessThan(order.commit);
  });

  it("persists one supplier-proposal snapshot, rolls back a failed outbox, then replays without another queue", async () => {
    const replay: SupplierReplayState = { resultat: null };
    const failedQueue = transactionalAuthoritativeQueue({ failOutbox: true });
    mocks.poolConnect.mockResolvedValueOnce({
      query: vi.fn(supplierProposalDispatcher(failedQueue, replay)),
      release: mocks.clientRelease,
    });

    await expect(repoConfirmPropositions(supplierProposalBody, supplierAudit)).rejects.toThrow("authoritative outbox unavailable");
    expect(replay.resultat).toBeNull();
    expect(failedQueue.committedArchives.size).toBe(0);
    expect(failedQueue.committedOutbox.size).toBe(0);
    expect(failedQueue.calls.some(({ statement }) => statement === "ROLLBACK")).toBe(true);

    const successfulQueue = transactionalAuthoritativeQueue();
    mocks.poolConnect.mockResolvedValueOnce({
      query: vi.fn(supplierProposalDispatcher(successfulQueue, replay)),
      release: mocks.clientRelease,
    });

    await expect(repoConfirmPropositions(supplierProposalBody, supplierAudit)).resolves.toMatchObject({
      idempotent_replay: false,
      commandes: [{ id: SUPPLIER_ORDER_ID, code: "BCF-2026-0042", fournisseur_id: SUPPLIER_ID }],
    });
    expect([...successfulQueue.committedArchives.keys()]).toEqual([`commande-fournisseur:${SUPPLIER_ORDER_ID}:creation:v1`]);
    expect([...successfulQueue.committedOutbox]).toEqual([`authoritative-pdf:commande-fournisseur:${SUPPLIER_ORDER_ID}:creation:v1`]);
    expect(successfulQueue.calls.filter(({ statement }) => statement.includes("INSERT INTO public.authoritative_pdf_archives"))).toHaveLength(1);
    expect(successfulQueue.calls.filter(({ statement }) => statement.includes("INSERT INTO public.authoritative_pdf_archive_outbox"))).toHaveLength(1);
    const order = indices(successfulQueue);
    expect(order.begin).toBeLessThan(order.archive);
    expect(order.archive).toBeLessThan(order.outbox);
    expect(order.outbox).toBeLessThan(order.commit);

    const replayQueue = transactionalAuthoritativeQueue();
    mocks.poolConnect.mockResolvedValueOnce({
      query: vi.fn(supplierProposalDispatcher(replayQueue, replay)),
      release: mocks.clientRelease,
    });

    await expect(repoConfirmPropositions(supplierProposalBody, supplierAudit)).resolves.toMatchObject({
      idempotent_replay: true,
      commandes: [{ id: SUPPLIER_ORDER_ID, code: "BCF-2026-0042", fournisseur_id: SUPPLIER_ID }],
    });
    expect(replayQueue.committedArchives.size).toBe(0);
    expect(replayQueue.committedOutbox.size).toBe(0);
    expect(replayQueue.calls.some(({ statement }) => statement.includes("INSERT INTO public.commande_fournisseur"))).toBe(false);
    expect(replayQueue.calls.some(({ statement }) => statement.includes("INSERT INTO public.authoritative_pdf_archives"))).toBe(false);
    expect(replayQueue.calls.some(({ statement }) => statement.includes("INSERT INTO public.authoritative_pdf_archive_outbox"))).toBe(false);
  });
});
