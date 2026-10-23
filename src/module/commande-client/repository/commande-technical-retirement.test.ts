import { describe, expect, it, vi } from "vitest";
import { repoRetireCommandeTechnicalReview } from "./commande-client.repository";
import { COMMANDE_WORKFLOW_ACTIONS, COMMANDE_WORKFLOW_CHECKPOINTS, canCommandeWorkflowTransition } from "../workflow/commande-client-workflow.definition";

const header = { id: 21,numero: "CMD-SYNTHETIC",client_id: "001",order_type: "FERME",statut: "ATTENTE_TECHNIQUE" as const,raw_statut: "ATTENTE_TECHNIQUE" };
function fixture(flags: { has_of?: boolean; stock_done?: boolean; status?: string; missing?: boolean } = {}) {
  let retired = false;
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("SELECT cp.status")) return { rows: retired || flags.missing ? [] : [{
      status:flags.status ?? "active",assigned_user_id:7,due_at:null,blocked_reason:"Plan client à éclaircir",notes:"Conserver le suivi",metadata:{},has_of:false,stock_done:false,...flags,
    }] };
    if (sql.includes("SET status='skipped'")) retired = true;
    if (sql.includes("SELECT nouveau_statut")) return { rows:[{ nouveau_statut:"ATTENTE_TECHNIQUE" }] };
    if (sql.includes("FROM commande_client")) return { rows:[header] };
    if (sql.includes("INSERT INTO commande_historique")) return { rows:[{ id:"31" }] };
    if (sql.includes("INSERT INTO public.commande_client_event_log")) return { rows:[{ id:"41" }] };
    return { rows:[],rowCount:1 };
  });
  return { tx:{ query } as never,query };
}

describe("retirement of the redundant command technical visa", () => {
  it("removes the action and connects administrative review to stock", () => {
    expect(COMMANDE_WORKFLOW_CHECKPOINTS.some(c=>c.code==="technical_analysis")).toBe(false);
    expect(COMMANDE_WORKFLOW_ACTIONS.some(a=>a.key==="complete_technical_analysis")).toBe(false);
    expect(COMMANDE_WORKFLOW_ACTIONS.find(a=>a.checkpoint_code==="commercial_review")?.next_checkpoint_code).toBe("stock_check");
    expect(canCommandeWorkflowTransition("EN_ANALYSE","ATTENTE_STOCK","checkpoint")).toBe(true);
  });
  it.each([
    [{},"stock_check","ATTENTE_STOCK"],
    [{ stock_done:true },"of_generation","ATTENTE_OF"],
    [{ has_of:true },"planning_validation","ATTENTE_PLANNING"],
  ] as const)("recovers the correct remaining step without creating business artifacts: %j", async (flags,checkpoint,status) => {
    const {tx,query}=fixture(flags);
    expect(await repoRetireCommandeTechnicalReview(tx,header)).toMatchObject({statut:status});
    expect(query.mock.calls.some(([sql,v])=>sql.includes("SET status=$3")&&v?.[1]===checkpoint)).toBe(true);
    const history=query.mock.calls.find(([sql])=>sql.includes("INSERT INTO commande_historique"));
    expect(history?.[1]).toEqual([21,null,"ATTENTE_TECHNIQUE",status,expect.any(String)]);
    expect(query.mock.calls.some(([sql])=>/(?:INSERT INTO|UPDATE)\s+(?:public\.)?(?:ordres_fabrication|stock_reservations|bon_livraison)\b/i.test(sql))).toBe(false);
    expect(query.mock.calls.some(([sql])=>sql.includes("SET status='skipped'")&&!sql.includes("completed_by"))).toBe(true);
    const writes=query.mock.calls.length;
    await repoRetireCommandeTechnicalReview(tx,header);
    expect(query.mock.calls).toHaveLength(writes+1);
  });
  it("keeps an explicit blocker, assignment and notes on the successor without a status-history transition", async () => {
    const {tx,query}=fixture({status:"blocked"});
    const result=await repoRetireCommandeTechnicalReview(tx,{...header,statut:"BLOQUE",raw_statut:"BLOQUE"});
    expect(result.statut).toBe("BLOQUE");
    const update=query.mock.calls.find(([sql])=>sql.includes("SET status=$3"));
    expect(update?.[1]).toEqual([21,"stock_check","blocked",7,null,"Plan client à éclaircir","Conserver le suivi",expect.stringContaining('"previous_status_before_block":"ATTENTE_STOCK"')]);
    expect(query.mock.calls.some(([sql])=>sql.includes("INSERT INTO commande_historique"))).toBe(false);
  });
  it("does not alter a command blocked elsewhere or one already beyond the retired step", async () => {
    const f=fixture();
    await repoRetireCommandeTechnicalReview(f.tx,{...header,statut:"BLOQUE",raw_statut:"BLOQUE"});
    expect(f.query).toHaveBeenCalledTimes(1);
    await repoRetireCommandeTechnicalReview(f.tx,{...header,statut:"AR_ENVOYE"});
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it("keeps internal commands on launch preparation",async()=>{
    const f=fixture();
    expect(await repoRetireCommandeTechnicalReview(f.tx,{...header,order_type:"INTERNE"})).toMatchObject({statut:"ATTENTE_OF"});
  });
});
