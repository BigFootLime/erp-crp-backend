import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import path from "node:path";
import ts from "typescript";
import type { CreateCommandeInput } from "../types/commande-client.types";
import { createCommandeCreationRepository, type CommandeCreationRepositoryDependencies } from "./commande-creation-transaction.repository";

const runtimeState = vi.hoisted(() => ({ enabled: true }));
vi.mock("../../entreprises/runtime/company-runtime.config", () => ({
  companyRuntimeConfiguration: () => ({ enabled: runtimeState.enabled, company_id: "company-1" }),
}));

const input: CreateCommandeInput = { client_id: "client-1", code_client: "C1", lignes: [] };

function fixture() {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
    calls.push(sql);
    if (sql.startsWith("SELECT nextval")) return { rows: [{ id: "41" }] };
    if (sql.includes("INSERT INTO commande_client")) return { rows: [{ id: "41" }] };
    return { rows: [] };
  });
  const client = { query } as unknown as PoolClient;
  const dependencies: CommandeCreationRepositoryDependencies<string, { id: string }> = {
    prepareContractCall: vi.fn(async () => "contract"), assertDevisDraftIsFresh: vi.fn(async () => undefined), toInt: (value: unknown) => Number(value),
    generateCommandeCode: vi.fn(async () => "CMD-41"), resolveIntercompanyDeliveryAddress: vi.fn(async () => ({ recipient_name: "Recipient", address_line_1: "1 rue", postal_code: "69000", city: "Lyon" })),
    repoCreateDropshipPurchaseOrderTx: vi.fn(async () => undefined), insertCommandeLignes: vi.fn(async () => undefined), recordContractCall: vi.fn(async () => undefined),
    insertCommandeEcheances: vi.fn(async () => undefined), insertCommandeDocuments: vi.fn(async () => undefined), transitionLinkedDevisArticlesToValide: vi.fn(async () => undefined),
    repoEnsureCommandeWorkflowCheckpoints: vi.fn(async () => undefined), insertCommandeEvent: vi.fn(async () => undefined), notifyWorkflowRole: vi.fn(async () => []), enqueueAppNotificationCreated: vi.fn(async () => undefined), queueCommandeCreationPdf: vi.fn(async () => undefined),
  };
  return { calls, client, dependencies, owner: createCommandeCreationRepository(dependencies), query };
}

describe("commande creation transaction owner", () => {
  it("preserves native creation SQL parameters and side-effect order on one client", async () => {
    const { calls, client, dependencies, owner, query } = fixture();
    await expect(owner.repoCreateCommandeNativeTx(client, { ...input, total_ht: 12, total_ttc: 14.4 }, 7)).resolves.toEqual({ id: 41, numero: "CMD-41" });
    expect(calls[0]).toContain("nextval('public.commande_client_id_seq')");
    expect(calls[1]).toContain("INSERT INTO commande_client");
    expect(query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([41, "CMD-41", "client-1", 12, 14.4, "STANDARD"]));
    expect(vi.mocked(dependencies.insertCommandeLignes).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(dependencies.recordContractCall).mock.invocationCallOrder[0]);
  });
  it("does not persist native side effects when pre-commit freshness fails", async () => {
    const { client, dependencies, owner, query } = fixture();
    vi.mocked(dependencies.assertDevisDraftIsFresh).mockRejectedValueOnce(new Error("DEVIS_DRAFT_STALE"));
    await expect(owner.repoCreateCommandeNativeTx(client, input, 7)).rejects.toThrow("DEVIS_DRAFT_STALE");
    expect(query).not.toHaveBeenCalled(); expect(dependencies.insertCommandeLignes).not.toHaveBeenCalled();
  });
  it("retains draft transaction policy without notification, documents or creation PDF", async () => {
    const { client, dependencies, owner } = fixture();
    await owner.repoCreateCommandeDraftTx(client, input, 7, "client_demand");
    expect(dependencies.insertCommandeLignes).toHaveBeenCalled(); expect(dependencies.notifyWorkflowRole).not.toHaveBeenCalled(); expect(dependencies.insertCommandeDocuments).not.toHaveBeenCalled(); expect(dependencies.queueCommandeCreationPdf).not.toHaveBeenCalled();
  });
  it("takes the dropship branch before contract persistence and skips checkpoints/notification", async () => {
    const { client, dependencies, owner } = fixture();
    await owner.repoCreateCommandeNativeTx(client, { ...input, fulfilment_mode: "SUPPLIER_DROPSHIP" }, 7);
    expect(dependencies.resolveIntercompanyDeliveryAddress).toHaveBeenCalledWith(client, expect.any(Object)); expect(dependencies.repoCreateDropshipPurchaseOrderTx).toHaveBeenCalled(); expect(dependencies.repoEnsureCommandeWorkflowCheckpoints).not.toHaveBeenCalled(); expect(dependencies.notifyWorkflowRole).not.toHaveBeenCalled();
  });
  it("ignores supplied numero and keeps generated-number/default nullable SQL policy", async () => {
    const { client, owner, query } = fixture();
    await owner.repoCreateCommandeNativeTx(client, { ...input, numero: "CALLER-MUST-NOT-WIN", contact_id: undefined, destinataire_id: undefined, total_ht: undefined, total_ttc: undefined }, 7);
    const params = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO commande_client"))?.[1] as unknown[];
    expect(params[1]).toBe("CMD-41"); expect(params).toEqual(expect.arrayContaining([null, 0, "STANDARD"]));
  });
  it("preserves draft cutover versus client-demand statuses and the same client reference", async () => {
    const cutover = fixture(); const demand = fixture();
    await cutover.owner.repoCreateCommandeDraftTx(cutover.client, input, 7, "cutover");
    await demand.owner.repoCreateCommandeDraftTx(demand.client, { ...input, order_type: "INTERNE" }, 7, "client_demand");
    expect(cutover.dependencies.repoEnsureCommandeWorkflowCheckpoints).toHaveBeenCalledWith(cutover.client, 41, "ATTENTE_TECHNIQUE");
    expect(demand.dependencies.repoEnsureCommandeWorkflowCheckpoints).toHaveBeenCalledWith(demand.client, 41, "BROUILLON");
    expect(cutover.dependencies.insertCommandeLignes).toHaveBeenCalledWith(cutover.client, "41", expect.any(Array), expect.any(Object));
  });
  it("keeps helper failure boundaries before and after id allocation", async () => {
    const before = fixture(); vi.mocked(before.dependencies.prepareContractCall).mockRejectedValueOnce(new Error("before-id"));
    await expect(before.owner.repoCreateCommandeNativeTx(before.client, input, 7)).rejects.toThrow("before-id"); expect(before.query).not.toHaveBeenCalled();
    const after = fixture(); vi.mocked(after.dependencies.insertCommandeLignes).mockRejectedValueOnce(new Error("after-id"));
    await expect(after.owner.repoCreateCommandeNativeTx(after.client, input, 7)).rejects.toThrow("after-id");
    expect(after.query).toHaveBeenCalledTimes(2); expect(after.dependencies.recordContractCall).not.toHaveBeenCalled();
  });
  it("requires an actor for dropship only after the shared header and line writes", async () => {
    const { client, dependencies, owner, query } = fixture();
    await expect(owner.repoCreateCommandeNativeTx(client, { ...input, fulfilment_mode: "SUPPLIER_DROPSHIP" }, null)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(query).toHaveBeenCalledTimes(2); expect(dependencies.repoCreateDropshipPurchaseOrderTx).not.toHaveBeenCalled(); expect(dependencies.recordContractCall).not.toHaveBeenCalled();
  });
  it("keeps CADRE on the regular stock workflow and rejects disabled dropship runtime after header writes", async () => {
    const cadre = fixture(); await cadre.owner.repoCreateCommandeNativeTx(cadre.client, { ...input, order_type: "CADRE" }, 7);
    expect(cadre.dependencies.repoEnsureCommandeWorkflowCheckpoints).toHaveBeenCalledWith(cadre.client, 41, "ATTENTE_STOCK");
    runtimeState.enabled = false; const dropship = fixture();
    await expect(dropship.owner.repoCreateCommandeNativeTx(dropship.client, { ...input, fulfilment_mode: "SUPPLIER_DROPSHIP" }, 7)).rejects.toMatchObject({ code: "INTERCOMPANY_RUNTIME_REQUIRED" });
    expect(dropship.query).toHaveBeenCalledTimes(2); expect(dropship.dependencies.repoCreateDropshipPurchaseOrderTx).not.toHaveBeenCalled();
    runtimeState.enabled = true;
  });
});


function sourceFunction(source: string, fileName: string, name: string) {
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found: ts.FunctionDeclaration | ts.FunctionExpression | undefined;
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!found?.body) throw new Error(`Missing ${name} in ${fileName}`);
  return { ast, node: found, body: found.body.getText(ast) };
}

function normalizeNestedBody(body: string) {
  return body.replace(/\r\n/g, "\n").split("\n").map((line, index) => index === 0 ? line : line.startsWith("  ") ? line.slice(2) : line).join("\n");
}

function creationBinding(source: string) {
  const ast = ts.createSourceFile("facade.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = ast.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
    .find(value => ts.isIdentifier(value.name) && value.name.text === "commandeCreationRepository");
  const initializer = declaration?.initializer;
  if (!initializer || !ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression)
    || initializer.expression.text !== "createCommandeCreationRepository") throw new Error("Missing real creation owner binding");
  const binding = initializer.arguments[0];
  if (!binding || !ts.isObjectLiteralExpression(binding)) throw new Error("Missing actual creation dependency object");
  return { ast, binding };
}

describe("commande creation mechanical seam proof", () => {
  const repositoryPath = path.join(process.cwd(), "src/module/commande-client/repository/commande-client.repository.ts");
  const ownerPath = path.join(process.cwd(), "src/module/commande-client/repository/commande-creation-transaction.repository.ts");
  const base = execFileSync("git", ["show", "37c6c5bfed76de85add3fc7e7ba73607750b18ba:src/module/commande-client/repository/commande-client.repository.ts"], { encoding: "utf8" });
  const facade = readFileSync(repositoryPath, "utf8");
  const owner = readFileSync(ownerPath, "utf8");

  it("keeps both moved transaction bodies byte-identical after only nesting normalization", () => {
    for (const name of ["repoCreateCommandeDraftTx", "repoCreateCommandeNativeTx"]) {
      const oldBody = sourceFunction(base, "base.ts", name).body;
      const newBody = sourceFunction(owner, "owner.ts", name).body;
      expect(normalizeNestedBody(newBody)).toBe(oldBody);
    }
  });

  it("retains all unaffected facade statements, public comments, and the actual binding names", () => {
    // The independent list-read owner characterizes these declarations against
    // the same historical facade; creation still protects every other statement.
    // List/detail declarations and the two contract-read imports have separate
    // actual-body/API/comment proofs; creation and workflow owner bodies have
    // their own actual-base proofs, and every other historical statement stays here.
    const excluded = new Set([
      "repoCreateCommandeDraftTx", "repoCreateCommandeNativeTx", "commandeCreationRepository",
      "repoListCommandes", "sortColumn", "sortDirection", "buildListWhere", "ListWhere",
      "IncludeFlags", "includeFlags", "repoGetCommande",
      "repoEnsureCommandeWorkflowStatus", "repoApplyCommandeWorkflowMilestone",
      "advanceInternalOrderWorkflowAfterGeneration", "repairLegacyNoOperationPlanningBypass",
      "advanceCustomerOrderWorkflowAfterLaunch", "repoRetireCommandeTechnicalReview",
      "repoEnsureCommandeWorkflowCheckpoints", "repoGetCommandeWorkflow",
      "repoUpdateCommandeWorkflowCheckpoint", "repoRunCommandeWorkflowAction",
      "commandeWorkflowRepository",
      "loadCommandeWorkflowHeader", "prepareStockOnlyCustomerOrderCheckpoints",
      "CommandeWorkflowHeader", "isSupplierDropship", "assertCommercialOnlyDropship",
      "WorkflowCheckpointRow", "checkpointStatusSet", "normalizeCheckpointStatus",
      "mapWorkflowCheckpoint", "checkpointSeedStatus", "loadCommandeWorkflowHeaderWithStatus",
      "loadCommandeWorkflowCheckpoints", "buildWorkflowView", "listUsersForCommandeWorkflowRole",
      "notifyWorkflowRole", "activateNextCheckpoint",
    ]);
    const bindingNames = (name: ts.BindingName): string[] => ts.isIdentifier(name)
      ? [name.text]
      : name.elements.flatMap(element => ts.isBindingElement(element) ? bindingNames(element.name) : []);
    const ownerAst = ts.createSourceFile("workflow-owner.ts", owner, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const ownerNames = new Set<string>();
    const collectOwnerNames = (node: ts.Node) => {
      if ((ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) {
        ownerNames.add(node.name.text);
      }
      if (ts.isVariableDeclaration(node)) for (const name of bindingNames(node.name)) ownerNames.add(name);
      ts.forEachChild(node, collectOwnerNames);
    };
    collectOwnerNames(ownerAst);
    const facadeAst = ts.createSourceFile("facade.ts", facade, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const facadeImportPaths = new Set(facadeAst.statements
      .filter(ts.isImportDeclaration)
      .map(statement => ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : ""));
    const ownerImportPaths = new Set(ownerAst.statements
      .filter(ts.isImportDeclaration)
      .map(statement => ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : ""));
    const statementTexts = (source: string) => {
      const ast = ts.createSourceFile("facade.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      return ast.statements.filter(statement => {
        if (ts.isFunctionDeclaration(statement) && statement.name && (excluded.has(statement.name.text) || ownerNames.has(statement.name.text))) return false;
        if ((ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && (excluded.has(statement.name.text) || ownerNames.has(statement.name.text))) return false;
        if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(d => bindingNames(d.name).some(name => excluded.has(name) || ownerNames.has(name)))) return false;
        if (ts.isImportDeclaration(statement) && [
          "commande-creation-transaction.repository", "commande-list-read.repository", "commande-detail-read.repository",
          "client-contract-calls.repository", "client-contract-legacy.repository",
          "commande-workflow.repository",
        ].some(moduleName => statement.moduleSpecifier.getText(ast).includes(moduleName))) return false;
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
          && !facadeImportPaths.has(statement.moduleSpecifier.text) && ownerImportPaths.has(statement.moduleSpecifier.text)) return false;
        if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)
          && statement.exportClause.elements.some(element => excluded.has(element.name.text))) return false;
        return true;
      }).map(statement => statement.getText(ast).replace(/\r\n/g, "\n"));
    };
    expect(statementTexts(facade)).toEqual(statementTexts(base));
    for (const comment of ["Cutover-only transaction primitive.", "The ordinary customer-order creation writes, joined to the caller's transaction.", "@deprecated compatibility name for data-cutover callers."]) expect(facade).toContain(comment);
    const { binding } = creationBinding(facade);
    const names = binding.properties.map(property => {
      if (!ts.isShorthandPropertyAssignment(property) && !ts.isPropertyAssignment(property)) throw new Error("Unexpected creation dependency spread");
      if (!ts.isIdentifier(property.name)) throw new Error("Creation dependency must retain its original name");
      return property.name.text;
    });
    expect(names).toEqual(["prepareContractCall", "assertDevisDraftIsFresh", "toInt", "generateCommandeCode", "resolveIntercompanyDeliveryAddress", "repoCreateDropshipPurchaseOrderTx", "insertCommandeLignes", "recordContractCall", "insertCommandeEcheances", "insertCommandeDocuments", "transitionLinkedDevisArticlesToValide", "repoEnsureCommandeWorkflowCheckpoints", "insertCommandeEvent", "notifyWorkflowRole", "enqueueAppNotificationCreated", "queueCommandeCreationPdf"]);
    expect(facade).toMatch(/return commandeCreationRepository\.repoCreateCommandeNativeTx\(client, input, actorUserId, documents, movedDocuments\);/);
    expect(owner).not.toContain("commande-client.repository");
  });

  it("looks up imported helpers only on invocation when initializing the actual facade binding", async () => {
    const original = fixture();
    const initialized: { repository?: typeof original.owner } = {};
    const reads: string[] = [];
    const sandbox = { ...original.dependencies, createCommandeCreationRepository, initialized };
    for (const name of ["generateCommandeCode", "repoCreateDropshipPurchaseOrderTx", "enqueueAppNotificationCreated"] as const) {
      Object.defineProperty(sandbox, name, {
        get: () => { reads.push(name); return original.dependencies[name]; },
      });
    }
    const { ast, binding } = creationBinding(facade);
    const code = ts.transpileModule(`initialized.repository = createCommandeCreationRepository(${binding.getText(ast)});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    runInNewContext(code, sandbox);
    expect(initialized.repository).toBeDefined();
    expect(reads).toEqual([]);
    expect(original.dependencies.generateCommandeCode).not.toHaveBeenCalled();
    await initialized.repository!.repoCreateCommandeDraftTx(original.client, input, 7);
    expect(reads).toEqual(["generateCommandeCode"]);
    expect(original.dependencies.generateCommandeCode).toHaveBeenCalledOnce();
  });
});
