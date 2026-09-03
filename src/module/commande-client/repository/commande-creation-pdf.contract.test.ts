import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.join(__dirname, "commande-client.repository.ts"), "utf8");
const productionSource = fs.readFileSync(path.join(__dirname, "../../production/repository/production.repository.ts"), "utf8");
const generationSource = fs.readFileSync(path.join(__dirname, "../../production/repository/production-generation.repository.ts"), "utf8");
const ofCreationPdfSource = fs.readFileSync(path.join(__dirname, "../../production/domain/of-creation-pdf.ts"), "utf8");

describe("commande creation PDF transaction contract", () => {
  it("queues the sanitized internal snapshot before the create transaction returns", () => {
    const queue = source.indexOf("await queueCommandeCreationPdf(client");
    const result = source.indexOf("return { id: toInt(commandeId");
    expect(queue).toBeGreaterThan(0);
    expect(queue).toBeLessThan(result);
    expect(source).toContain('documentKind: "CUSTOMER_ORDER_CREATION_SNAPSHOT"');
    expect(source).toContain('idempotencyKey: `commande-client:${header.id}:creation:v1`');
    expect(source).toContain("buildInternalCreationSnapshot");
    expect(source).not.toContain("dc.document_path");
  });

  it("locks only the customer-order row when the snapshot header uses optional joins", () => {
    const snapshotStart = source.indexOf("async function queueCommandeCreationPdf");
    const snapshot = source.slice(snapshotStart, source.indexOf("const header = headerRes.rows[0]", snapshotStart));
    expect(snapshot).toContain("LEFT JOIN public.clients c");
    expect(snapshot).toContain("LEFT JOIN public.adresse_facturation af");
    expect(snapshot).toContain("FOR UPDATE OF cc");
    expect(snapshot.match(/FOR UPDATE/g)).toHaveLength(1);
  });

  it("derives PDF line positions from the stable line id instead of a non-existent ordre column", () => {
    const snapshotStart = source.indexOf("async function queueCommandeCreationPdf");
    const snapshotEnd = source.indexOf("const toText", snapshotStart);
    const snapshot = source.slice(snapshotStart, snapshotEnd);
    expect(snapshot).toContain("(ROW_NUMBER() OVER (ORDER BY cl.id ASC))::int AS ordre");
    expect(snapshot).toContain("FROM public.commande_ligne cl WHERE cl.commande_id = $1::bigint ORDER BY cl.id ASC");
    expect(snapshot).not.toContain("ordre::int AS ordre");
    expect(snapshot).not.toContain("ORDER BY ordre ASC");
  });

  it("queues manual and generated OF roots inside their transactions, excluding children", () => {
    const manualQueue = productionSource.indexOf("await queueRootOfCreationPdf(client");
    const manualReturn = productionSource.indexOf("return ofId;", manualQueue);
    expect(manualQueue).toBeGreaterThan(0);
    expect(manualQueue).toBeLessThan(manualReturn);
    expect(generationSource).toContain("generated.ofs.filter((of) => of.parent_of_id === null)");
    expect(source).toContain("generatedOfs.filter((of) => of.parent_of_id === null)");
    expect(generationSource).toContain("await queueRootOfCreationPdf(client");
    expect(source).toContain("await queueRootOfCreationPdf(client");
  });

  it("archives clones only after their cloned aggregate is complete and before commit", () => {
    const duplicateStart = source.indexOf("export async function repoDuplicateCommande");
    const duplicate = source.slice(duplicateStart);
    const checkpoints = duplicate.indexOf("await repoEnsureCommandeWorkflowCheckpoints");
    const queue = duplicate.indexOf("await queueCommandeCreationPdf(client");
    const commit = duplicate.indexOf('await client.query("COMMIT")');
    expect(checkpoints).toBeGreaterThan(0);
    expect(queue).toBeGreaterThan(checkpoints);
    expect(queue).toBeLessThan(commit);
  });

  it("covers every lifecycle-created affaire while preserving replay no-op paths", () => {
    const created = (source.match(/await createAffaire\(client/g) ?? []).length;
    const queued = (source.match(/await queueAffaireCreationPdf\(client/g) ?? []).length;
    // The command workflow now creates the principal affair in addition to the
    // delivery affairs covered by the historical contract.
    expect(created).toBe(6);
    expect(queued).toBe(created);
    expect(source).toContain('documentKind: "AFFAIR_CREATION_SNAPSHOT"');
    expect(source).toContain('idempotencyKey: `affaire:${affaire.id}:creation:v1`');
    // Existing mappings return before any create helper call, so a replay has no queue side effect.
    expect(source).toContain("if (existingLivraisons.length >= requestedLivraisonCount)");
  });

  it("locks only the generated business rows when creation snapshots use optional client joins", () => {
    const affaireStart = source.indexOf("async function queueAffaireCreationPdf");
    const affaire = source.slice(affaireStart, source.indexOf("const affaire = source.rows[0]", affaireStart));
    expect(affaire).toContain("LEFT JOIN public.clients c");
    expect(affaire).toContain("LEFT JOIN public.commande_client cc");
    expect(affaire).toContain("FOR UPDATE OF a");
    expect(affaire.match(/FOR UPDATE/g)).toHaveLength(1);

    expect(ofCreationPdfSource).toContain("LEFT JOIN public.clients c");
    expect(ofCreationPdfSource).toContain("FOR UPDATE OF o");
    expect(ofCreationPdfSource.match(/FOR UPDATE/g)).toHaveLength(1);
  });
});
