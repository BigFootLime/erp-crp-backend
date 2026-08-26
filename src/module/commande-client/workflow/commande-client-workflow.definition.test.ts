import { describe, expect, it } from "vitest";

import { canCommandeWorkflowTransition } from "./commande-client-workflow.definition";

describe("customer stock-only acknowledgement workflow", () => {
  it("routes a fully stocked launch through AR before delivery", () => {
    expect(canCommandeWorkflowTransition("ATTENTE_OF", "AR_PRET", "customer_order_launch")).toBe(true);
    expect(canCommandeWorkflowTransition("ATTENTE_OF", "PRET_LIVRAISON", "customer_order_launch")).toBe(false);
    expect(canCommandeWorkflowTransition("AR_ENVOYE", "PRET_LIVRAISON", "ar_send")).toBe(true);
  });

  it("keeps the shortage route behind planning", () => {
    expect(canCommandeWorkflowTransition("ATTENTE_OF", "ATTENTE_PLANNING", "customer_order_launch")).toBe(true);
  });

  it("allows the audited repair of the former no-operation planning bypass only", () => {
    expect(canCommandeWorkflowTransition("AR_PRET", "ATTENTE_PLANNING", "planning_repair")).toBe(true);
    expect(canCommandeWorkflowTransition("AR_ENVOYE", "ATTENTE_PLANNING", "planning_repair")).toBe(false);
  });
});
