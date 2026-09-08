import {beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({connect:vi.fn(),create:vi.fn(),post:vi.fn(),get:vi.fn(),transfer:vi.fn(),lock:vi.fn(),quality:vi.fn()}));
vi.mock("../../qualite/repository/quality-operational-gate.repository",()=>({assertReceiptLotQualityEligibility:mocks.quality}));
vi.mock("../../../config/database",()=>({default:{connect:mocks.connect}}));
vi.mock("../../stock/repository/stock.repository",()=>({repoCreateMovement:mocks.create,repoPostMovement:mocks.post,repoGetMovement:mocks.get}));
vi.mock("../../production/repository/of-material-receipts.repository",()=>({lockMaterialReceiptRecipientsTx:mocks.lock,transferMaterialReceiptTx:mocks.transfer}));
vi.mock("../../commande-fournisseur/repository/commande-fournisseur.repository",()=>({repoRefreshCommandeReceptionState:vi.fn()}));
vi.mock("../../audit-logs/repository/audit-logs.repository",()=>({repoInsertAuditLog:vi.fn(async()=>({id:"audit",created_at:"2026-09-08"}))}));
vi.mock("./receptions-realtime.repository",()=>({enqueueReceptionChanged:vi.fn(),receptionRealtimeActionFromAudit:()=>"updated"}));
import {repoCreateStockReceipt,type AuditContext} from "./receptions.repository";
import {hashStockCommand} from "../../stock/domain/stock-command";
const audit:AuditContext={user_id:1,ip:null,user_agent:null,device_type:null,os:null,browser:null,path:null,page_key:null,client_session_id:null};
const request={qty:2,dst_magasin_id:"warehouse",dst_emplacement_id:1};
let client:{query:ReturnType<typeof vi.fn>;release:ReturnType<typeof vi.fn>};
beforeEach(()=>{
  vi.clearAllMocks();
  client={release:vi.fn(),query:vi.fn(async(sql:string,_values?:unknown[])=>{
    if(sql.includes("l.qty_received::float8"))return {rows:[{id:"line",qty_received:3,article_id:"article",unite:"barre",stock_unit:"mm",stock_conversion_coef:3000,article_unit:"mm",lot_id:"lot",lot_status:"LIBERE",reception_no:"RF-TEST",reception_status:"OPEN"}]};
    if(sql.includes("FROM public.stock_command_receipts"))return {rows:[]};
    if(sql.includes("SELECT request_hash,stock_movement_id"))return {rows:[]};
    if(sql.includes("SUM(qty)"))return {rows:[{qty:0}]};
    if(sql.includes("INSERT INTO public.reception_fournisseur_stock_receipts"))return {rows:[{id:"receipt"}]};
    if(["BEGIN","COMMIT","ROLLBACK"].includes(sql)||sql.includes("pg_advisory_xact_lock"))return {rows:[]};
    throw new Error(`Unexpected query: ${sql}`);
  })};
  mocks.connect.mockResolvedValue(client);mocks.lock.mockResolvedValue(true);mocks.transfer.mockResolvedValue([]);
  mocks.create.mockResolvedValue({movement:{id:"movement"}});mocks.post.mockResolvedValue({movement:{id:"movement",movement_no:"MV-TEST"}});
});
describe("Stock receipt transaction ownership",()=>{
  it("posts converted stock and records received units in the same transaction as its allocations",async()=>{
    await repoCreateStockReceipt("reception","line",request,audit,"receipt-test-key");
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({lines:expect.arrayContaining([expect.objectContaining({qty:6000,unite:"mm"})])}),audit,{trusted_source_flow:true,client});
    expect(mocks.post.mock.calls[0][4]).toBe(client);
    expect(mocks.transfer).toHaveBeenCalledWith(client,"receipt",audit);
    expect(mocks.quality).toHaveBeenCalledWith({client,lotId:"lot",receiptLineId:"line",qty:6000,unit:"mm"});
    const receiptCall=client.query.mock.calls.find(([sql])=>sql.includes("INSERT INTO public.reception_fournisseur_stock_receipts"));
    expect(receiptCall?.[1]?.[3]).toBe(2);
    expect(client.query).toHaveBeenCalledWith("COMMIT");expect(client.query).not.toHaveBeenCalledWith("ROLLBACK");expect(client.release).toHaveBeenCalledTimes(1);
  });
  it("rolls back the stock movement and receipt when the promised allocation fails",async()=>{
    mocks.transfer.mockRejectedValueOnce(new Error("Concurrent quality refusal"));
    await expect(repoCreateStockReceipt("reception","line",request,audit,"receipt-test-key")).rejects.toThrow("Concurrent quality refusal");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");expect(client.query).not.toHaveBeenCalledWith("COMMIT");expect(client.release).toHaveBeenCalledTimes(1);
  });
  it("rejects oversupply before creating a stock movement",async()=>{
    await expect(repoCreateStockReceipt("reception","line",{...request,qty:4},audit,"receipt-test-key")).rejects.toMatchObject({code:"OVER_RECEIPT"});
    expect(mocks.create).not.toHaveBeenCalled();expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });
  it("does not write stock when the quality release covers less than the received quantity",async()=>{
    mocks.quality.mockRejectedValueOnce(new Error("Only one bar was accepted"));
    await expect(repoCreateStockReceipt("reception","line",request,audit,"receipt-test-key")).rejects.toThrow("Only one bar was accepted");
    expect(mocks.create).not.toHaveBeenCalled();expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });
  it("replays the same command even when stock or article conversion has since changed",async()=>{
    client.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("SELECT request_hash,stock_movement_id"))return {rows:[{request_hash:hashStockCommand("RECEPTION_STOCK_RECEIPT",{receptionId:"reception",lineId:"line",body:request}),stock_movement_id:"movement"}]};
      if(["BEGIN","COMMIT","ROLLBACK"].includes(sql)||sql.includes("pg_advisory_xact_lock"))return {rows:[]};
      throw new Error("A replay must not reread mutable receipt quantities");
    });
    mocks.get.mockResolvedValueOnce({movement:{id:"movement",movement_no:"MV-TEST"}});
    await expect(repoCreateStockReceipt("reception","line",request,audit,"receipt-test-key")).resolves.toMatchObject({stock_movement_id:"movement"});
    expect(mocks.create).not.toHaveBeenCalled();expect(mocks.quality).not.toHaveBeenCalled();expect(mocks.transfer).not.toHaveBeenCalled();
    await expect(repoCreateStockReceipt("reception","line",{...request,qty:1},audit,"receipt-test-key")).rejects.toMatchObject({code:"IDEMPOTENCY_KEY_REUSED"});
  });
});
