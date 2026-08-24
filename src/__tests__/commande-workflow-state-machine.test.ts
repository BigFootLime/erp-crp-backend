import fs from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  COMMANDE_WORKFLOW_BLOCKABLE_STATUSES,
  COMMANDE_WORKFLOW_CONTRACT,
  COMMANDE_WORKFLOW_LEGACY_STATUS_ALIASES,
  COMMANDE_WORKFLOW_STATUSES,
  COMMANDE_WORKFLOW_TRANSITION_CAUSES,
  COMMANDE_WORKFLOW_TRANSITIONS,
  canCommandeWorkflowTransition,
  isCanonicalCommandeWorkflowStatus,
  normalizeCommandeWorkflowStatus,
  type CommandeWorkflowStatus,
} from "../module/commande-client/workflow/commande-client-workflow.definition"
import { repoEnsureCommandeWorkflowStatus } from "../module/commande-client/repository/commande-client.repository"
import { canActOnCommandeWorkflowCheckpoint } from "../module/commande-client/domain/commande-client-rbac"

describe("commande workflow canonical state machine", () => {
  it("accepts only the declared pair for every static cause/status combination", () => {
    const staticCauses = COMMANDE_WORKFLOW_TRANSITION_CAUSES.filter(
      (cause) => cause !== "block" && cause !== "resume",
    )

    for (const cause of staticCauses) {
      for (const from of COMMANDE_WORKFLOW_STATUSES) {
        for (const to of COMMANDE_WORKFLOW_STATUSES) {
          const declared = from === to || COMMANDE_WORKFLOW_TRANSITIONS.some(
            (rule) => rule.from === from && rule.to === to && rule.cause === cause,
          )
          expect(
            canCommandeWorkflowTransition(from, to, cause),
            `${cause}: ${from} -> ${to}`,
          ).toBe(declared)
        }
      }
    }
  })

  it("blocks only a non-terminal current status and resumes only the exact stored status", () => {
    for (const from of COMMANDE_WORKFLOW_STATUSES) {
      expect(canCommandeWorkflowTransition(from, "BLOQUE", "block"), from).toBe(
        from === "BLOQUE" || COMMANDE_WORKFLOW_BLOCKABLE_STATUSES.includes(
          from as Exclude<CommandeWorkflowStatus, "ARCHIVE" | "BLOQUE">,
        ),
      )
    }

    for (const resumeStatus of COMMANDE_WORKFLOW_BLOCKABLE_STATUSES) {
      for (const target of COMMANDE_WORKFLOW_STATUSES) {
        expect(
          canCommandeWorkflowTransition("BLOQUE", target, "resume", { resume_status: resumeStatus }),
          `resume ${resumeStatus}: BLOQUE -> ${target}`,
        ).toBe(target === "BLOQUE" || target === resumeStatus)
      }
    }
    expect(canCommandeWorkflowTransition("BLOQUE", "EN_ANALYSE", "resume")).toBe(false)
    expect(COMMANDE_WORKFLOW_CONTRACT.checkpoint_transitions.BLOQUE).toEqual([])
  })

  it("preserves the audited business shortcuts and rejects the adjacent unauthorized jumps", () => {
    expect(canCommandeWorkflowTransition("ATTENTE_OF", "ATTENTE_PLANNING", "customer_order_launch")).toBe(true)
    expect(canCommandeWorkflowTransition("ATTENTE_OF", "AR_PRET", "customer_order_launch")).toBe(true)
    expect(canCommandeWorkflowTransition("ATTENTE_TECHNIQUE", "ATTENTE_PLANNING", "internal_order_launch")).toBe(true)
    expect(canCommandeWorkflowTransition("ATTENTE_PLANNING", "AR_PRET", "checkpoint")).toBe(false)
    expect(canCommandeWorkflowTransition("AR_PRET", "AR_ENVOYE", "ar_send")).toBe(true)
    expect(canCommandeWorkflowTransition("AR_ENVOYE", "PRET_LIVRAISON", "ar_send")).toBe(true)
    expect(canCommandeWorkflowTransition("PRODUCTION_TERMINEE", "PRET_LIVRAISON", "checkpoint")).toBe(true)
    expect(canCommandeWorkflowTransition("ATTENTE_PLANNING", "PLANNING_VALIDE", "internal_planning_validation")).toBe(true)
    expect(canCommandeWorkflowTransition("PLANNING_VALIDE", "EN_PRODUCTION", "internal_production_launch")).toBe(true)
    expect(canCommandeWorkflowTransition("LIVRE", "ARCHIVE", "internal_archive")).toBe(true)

    expect(canCommandeWorkflowTransition("ATTENTE_OF", "PRET_LIVRAISON", "customer_order_launch")).toBe(false)
    expect(canCommandeWorkflowTransition("ATTENTE_PLANNING", "PRET_LIVRAISON", "planning_sync")).toBe(false)
    expect(canCommandeWorkflowTransition("LIVRE", "PRET_LIVRAISON", "checkpoint")).toBe(false)
    expect(canCommandeWorkflowTransition("FACTURE", "LIVRE", "checkpoint")).toBe(false)
    expect(COMMANDE_WORKFLOW_CONTRACT.checkpoint_transitions.ATTENTE_OF).toEqual([])
    expect(COMMANDE_WORKFLOW_CONTRACT.checkpoint_transitions.ATTENTE_PLANNING).toEqual(["PLANNING_VALIDE"])
  })

  it("runs the canonical internal path without manufacturing AR or invoice states", async () => {
    let currentStatus = "ATTENTE_PLANNING"
    let historyId = 0
    const writtenStatuses: string[] = []
    const query = vi.fn(async (sql: unknown, values?: unknown[]) => {
      const statement = String(sql)
      if (statement.includes("FROM commande_client") && statement.includes("FOR UPDATE")) {
        return { rows: [{ id: 123, numero: "CI-123", client_id: "001", order_type: "INTERNE" }] }
      }
      if (statement.includes("SELECT nouveau_statut")) return { rows: [{ nouveau_statut: currentStatus }] }
      if (statement.includes("INSERT INTO commande_historique")) {
        currentStatus = String(values?.[3])
        writtenStatuses.push(currentStatus)
        historyId += 1
        return { rows: [{ id: String(historyId) }] }
      }
      return { rows: [] }
    })
    const tx = { query } as never
    const steps = [
      ["PLANNING_VALIDE", "internal_planning_validation"],
      ["EN_PRODUCTION", "internal_production_launch"],
      ["PRODUCTION_TERMINEE", "checkpoint"],
      ["PRET_LIVRAISON", "checkpoint"],
      ["LIVRE", "shipment_sync"],
      ["ARCHIVE", "internal_archive"],
    ] as const

    for (const [target, cause] of steps) {
      const result = await repoEnsureCommandeWorkflowStatus({
        tx,
        commande_id: 123,
        nouveau_statut: target,
        cause,
        commentaire: `internal ${target}`,
        user_id: 1,
      })
      expect(result.changed, `${cause} -> ${target}`).toBe(true)
    }

    expect(writtenStatuses).toEqual([
      "PLANNING_VALIDE",
      "EN_PRODUCTION",
      "PRODUCTION_TERMINEE",
      "PRET_LIVRAISON",
      "LIVRE",
      "ARCHIVE",
    ])
    expect(writtenStatuses).not.toContain("AR_PRET")
    expect(writtenStatuses).not.toContain("AR_ENVOYE")
    expect(writtenStatuses).not.toContain("FACTURE")

    const standardTx = {
      query: vi.fn(async (sql: unknown) => String(sql).includes("FROM commande_client")
        ? { rows: [{ id: 456, numero: "CC-456", client_id: "001", order_type: "STANDARD" }] }
        : { rows: [] }),
    } as never
    await expect(repoEnsureCommandeWorkflowStatus({
      tx: standardTx,
      commande_id: 456,
      nouveau_statut: "EN_PRODUCTION",
      cause: "internal_production_launch",
      commentaire: null,
      user_id: 1,
    })).rejects.toMatchObject({ code: "INTERNAL_COMMAND_TRANSITION_REQUIRED", status: 409 })
  })

  it("keeps legacy aliases read-only while write targets remain canonical", () => {
    for (const [legacy, canonical] of Object.entries(COMMANDE_WORKFLOW_LEGACY_STATUS_ALIASES)) {
      expect(normalizeCommandeWorkflowStatus(legacy)).toBe(canonical)
      expect(isCanonicalCommandeWorkflowStatus(legacy)).toBe(false)
      expect(isCanonicalCommandeWorkflowStatus(canonical)).toBe(true)
    }
    expect(normalizeCommandeWorkflowStatus("unknown")).toBeNull()
  })

  it("keeps the committed JSON artifact byte-for-structure aligned with backend authority", () => {
    const contractPath = path.resolve(process.cwd(), "contracts/commande-client-workflow.v1.json")
    const generated = JSON.parse(fs.readFileSync(contractPath, "utf8"))
    expect(generated).toEqual(COMMANDE_WORKFLOW_CONTRACT)
    expect(generated.authority).toBe("erp-crp-backend")
  })

  it("repairs a legacy command without history only through the safe BROUILLON first step", async () => {
    const query = vi.fn(async (sql: unknown) => {
      const statement = String(sql)
      if (statement.includes("FROM commande_client")) {
        return { rows: [{ id: 123, numero: "CC-123", client_id: "001" }] }
      }
      if (statement.includes("SELECT nouveau_statut")) return { rows: [] }
      if (statement.includes("INSERT INTO commande_historique")) return { rows: [{ id: "45" }] }
      return { rows: [] }
    })

    const result = await repoEnsureCommandeWorkflowStatus({
      tx: { query } as never,
      commande_id: 123,
      nouveau_statut: "EN_ANALYSE",
      cause: "checkpoint",
      commentaire: "first canonical checkpoint",
      user_id: 1,
    })

    expect(result).toMatchObject({ changed: true, ancien_statut: null, nouveau_statut: "EN_ANALYSE" })
    const historyCall = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO commande_historique"))
    expect(historyCall?.[1]).toEqual([123, 1, null, "EN_ANALYSE", "first canonical checkpoint"])

    await expect(repoEnsureCommandeWorkflowStatus({
      tx: { query } as never,
      commande_id: 123,
      nouveau_statut: "ATTENTE_STOCK",
      cause: "checkpoint",
      commentaire: "unsafe jump",
      user_id: 1,
    })).rejects.toMatchObject({ code: "ILLEGAL_COMMAND_STATUS_TRANSITION", status: 409 })
  })

  it("rejects legacy aliases and backward values as write targets", async () => {
    const query = vi.fn(async (sql: unknown) => {
      const statement = String(sql)
      if (statement.includes("FROM commande_client")) {
        return { rows: [{ id: 123, numero: "CC-123", client_id: "001" }] }
      }
      if (statement.includes("SELECT nouveau_statut")) return { rows: [{ nouveau_statut: "ATTENTE_STOCK" }] }
      return { rows: [] }
    })

    await expect(repoEnsureCommandeWorkflowStatus({
      tx: { query } as never,
      commande_id: 123,
      nouveau_statut: "PLANIFIEE" as CommandeWorkflowStatus,
      cause: "planning_sync",
      commentaire: null,
      user_id: 1,
    })).rejects.toMatchObject({ code: "INVALID_COMMAND_STATUS", status: 400 })

    await expect(repoEnsureCommandeWorkflowStatus({
      tx: { query } as never,
      commande_id: 123,
      nouveau_statut: "EN_ANALYSE",
      cause: "checkpoint",
      commentaire: null,
      user_id: 1,
    })).rejects.toMatchObject({ code: "ILLEGAL_COMMAND_STATUS_TRANSITION", status: 409 })
  })

  it.each([
    ["secretariat", "Secretaire"],
    ["technique", "Method"],
    ["planning", "Planification"],
    ["production", "Production"],
    ["qualite", "Responsable Qualité"],
    ["logistique", "Logistique"],
    ["comptabilite", "Comptabilite"],
    ["direction", "Directeur"],
  ])("enforces server-side checkpoint ownership for %s", (responsibleRole, allowedRole) => {
    expect(canActOnCommandeWorkflowCheckpoint({
      user_id: 1,
      user_role: allowedRole,
      responsible_role: responsibleRole,
    })).toBe(true)
    expect(canActOnCommandeWorkflowCheckpoint({
      user_id: 1,
      user_role: "Employee",
      responsible_role: responsibleRole,
    })).toBe(false)
    expect(canActOnCommandeWorkflowCheckpoint({
      user_id: 1,
      user_role: allowedRole,
      responsible_role: responsibleRole,
      assigned_user_id: 2,
    })).toBe(allowedRole === "Directeur")
    expect(canActOnCommandeWorkflowCheckpoint({
      user_id: 1,
      user_role: "Administrateur Systeme et Reseau",
      responsible_role: responsibleRole,
      assigned_user_id: 2,
    })).toBe(true)
  })

  it("uses the checkpoint policy for both AR generation and sending", () => {
    for (const role of ["Secretaire", "Commercial", "Comptabilite", "Directeur", "Administrateur Systeme et Reseau"]) {
      expect(canActOnCommandeWorkflowCheckpoint({
        user_id: 1,
        user_role: role,
        responsible_role: "secretariat",
      }), role).toBe(true)
    }
    expect(canActOnCommandeWorkflowCheckpoint({ user_id: 1, user_role: "Employee | Secretaire", responsible_role: "secretariat" })).toBe(true)
    expect(canActOnCommandeWorkflowCheckpoint({ user_id: 1, user_role: "Stagiaire admin", responsible_role: "secretariat" })).toBe(false)
    expect(canActOnCommandeWorkflowCheckpoint({ user_id: 1, user_role: "Employee", responsible_role: "secretariat", assigned_user_id: 1 })).toBe(true)
  })
})
