import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({query:vi.fn(),audit:vi.fn(),scan:vi.fn(),receipt:vi.fn(),acquire:vi.fn(),row:null as any,doc:null as any,measurements:[] as any[]}));
vi.mock("../../../config/database",()=>({default:{query:mocks.query,connect:async()=>({query:mocks.query})}}));
vi.mock("../../../shared/realtime/realtime-outbox-transaction",()=>({withRealtimeOutboxTransaction:async(client:any,run:any)=>run(client)}));
vi.mock("../../../shared/realtime/realtime-outbox.service",()=>({enqueueEntityChanged:vi.fn()}));
vi.mock("../../audit-logs/repository/audit-logs.repository",()=>({repoInsertAuditLog:mocks.audit}));
vi.mock("./quality-command-receipt.repository",()=>({acquireIdempotency:mocks.acquire,saveReceipt:mocks.receipt}));
vi.mock("./autocontrol-scan",()=>({verifyAutocontrolScanFile:mocks.scan}));
import { qualitySha256 } from "../domain/quality-policy";
import { repoRecordAutocontrolCapture, repoPreviewVerdict, repoRecordMeasurements } from "./quality-360.repository";
const id="11111111-1111-4111-8111-111111111111",op="22222222-2222-4222-8222-222222222222",document="33333333-3333-4333-8333-333333333333",hash="a".repeat(64);
const actor={user_id:2,role:"Responsable qualité",request_id:null,ip:null,user_agent:null,device_type:null,os:null,browser:null,page_key:null,path:null,client_session_id:null};
const body=()=>({mode:"PAPER" as const,expected_updated_at:mocks.row.updated_at,document_id:document,complete_sheet:true as const,conforming_qty:3,instruments:[]});
beforeEach(()=>{
  const snapshot={schema:"cerp.quality.plan-snapshot.v1",characteristics:[]};
  mocks.row={id,reference:"CQ-RECETTE",of_id:95,operation_id:op,source_type:"OF_OPERATION",source_id:op,trigger_type:"IN_PROCESS",status:"IN_PROGRESS",validation_date:null,
    plan_snapshot:snapshot,plan_snapshot_sha256:qualitySha256(snapshot),paper_capture:null,qty_population:"4",qty_controlled:"0",qty_conforming:"0",qty_released:"0",qty_held:"0",qty_scrapped:"0",qty_reworked:"0",qty_sorted:"0",qty_returned:"0",qty_consumed:"0",
    verdict:"EN_ATTENTE",verdict_computed:"EN_ATTENTE",unite:"u",updated_at:"2026-10-14T12:00:00Z",control_date:"2026-10-14T12:00:00Z",controlled_by:1,correlation_id:op};
  mocks.doc={id:document,removed_at:null,storage_path:"private-sheet.pdf",mime_type:"application/pdf",size_bytes:"100",sha256:hash};mocks.measurements=[];
  mocks.audit.mockReset().mockResolvedValue({id:"audit"});mocks.scan.mockReset().mockResolvedValue(hash);mocks.receipt.mockReset().mockResolvedValue(undefined);
  mocks.acquire.mockReset().mockResolvedValue({idempotencyKey:"capture-key",requestHash:hash,replay:null});
  mocks.query.mockReset().mockImplementation(async(sql:string,args:any[]=[])=>{
    if(sql.includes("FROM public.quality_control qc"))return{rows:[mocks.row]};
    if(sql.includes("FROM public.quality_control_points"))return{rows:mocks.measurements};
    if(sql.includes("FROM public.quality_documents"))return{rows:mocks.doc?[mocks.doc]:[]};
    if(sql.includes("INSERT INTO public.quality_autocontrol_capture"))mocks.row.paper_capture={document_id:args[1],document_sha256:args[2],conforming_qty:args[3],captured_by:args[5],captured_at:"2026-10-14T12:01:00Z",instruments:[]};
    if(sql.includes("UPDATE public.quality_control SET qty_controlled"))Object.assign(mocks.row,{qty_controlled:String(args[1]),qty_conforming:String(args[2]),verdict:args[3],verdict_computed:args[3],controlled_by:args[4],updated_at:"2026-10-14T12:01:00Z"});
    if(sql.includes("DELETE FROM public.quality_autocontrol_capture"))mocks.row.paper_capture=null;
    return{rows:[{id:"event",created_at:"2026-10-14T12:00:00Z"}],rowCount:1};
  });
});
describe("Paper capture command preserves explicit quality release",()=>{
  it("stores an audited partial result and exact evidence without measurements or release",async()=>{
    const result=await repoRecordAutocontrolCapture({id,body:body(),actor,idempotencyKey:"capture-key"});
    expect(result).toMatchObject({capture_mode:"PAPER",verdict:"PARTIEL",controlled_by:2,ledger:{controlled:4,conforming:3,released:0,held:0},measurements:[]});
    expect(mocks.scan).toHaveBeenCalledWith(mocks.doc,true);expect(mocks.receipt).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO public.quality_control_points")||String(sql).includes("INSERT INTO public.quality_release_decision"))).toBe(false);
    const preview=await repoPreviewVerdict(id);expect(preview).toMatchObject({verdict:"PARTIEL",missing:[],releasable_qty:3});
  });
  it("rejects a missing or foreign document before the ledger changes",async()=>{
    mocks.doc=null;await expect(repoRecordAutocontrolCapture({id,body:body(),actor,idempotencyKey:"missing"})).rejects.toMatchObject({code:"AUTOCONTROL_SCAN_REQUIRED"});
    expect(mocks.scan).not.toHaveBeenCalled();expect(mocks.receipt).not.toHaveBeenCalled();expect(mocks.row.qty_controlled).toBe("0");
  });
  it("rejects an unverified file without accepting the capture",async()=>{
    mocks.scan.mockRejectedValue(new Error("Antivirus unavailable"));
    await expect(repoRecordAutocontrolCapture({id,body:body(),actor,idempotencyKey:"bad-file"})).rejects.toThrow("Antivirus unavailable");expect(mocks.receipt).not.toHaveBeenCalled();
  });
  it("does not replace existing tablet values with a paper summary",async()=>{
    mocks.measurements=[{id:"measure"}];await expect(repoRecordAutocontrolCapture({id,body:body(),actor,idempotencyKey:"mixed"})).rejects.toMatchObject({code:"AUTOCONTROL_CAPTURE_MIXED"});
  });
  it("blocks tablet writes while the paper mode is persisted",async()=>{
    mocks.row.paper_capture={document_id:document,document_sha256:hash,conforming_qty:3};
    await expect(repoRecordMeasurements({id,actor,body:{expected_updated_at:mocks.row.updated_at,measurements:[]}})).rejects.toMatchObject({code:"AUTOCONTROL_PAPER_MODE"});
  });
  it("keeps already-decided or stale controls unchanged",async()=>{
    const input={id,body:body(),actor,idempotencyKey:"closed"};mocks.row.validation_date=mocks.row.updated_at;
    await expect(repoRecordAutocontrolCapture(input)).rejects.toMatchObject({code:"QUALITY_EXECUTION_CLOSED"});expect(mocks.receipt).not.toHaveBeenCalled();
    mocks.row.validation_date=null;input.body.expected_updated_at="2026-10-14T11:00:00Z";
    await expect(repoRecordAutocontrolCapture(input)).rejects.toMatchObject({status:409});
  });
  it("replays a committed command without another capture, scan or receipt",async()=>{
    mocks.acquire.mockResolvedValue({idempotencyKey:"capture-key",requestHash:hash,replay:{control_id:id}});
    await repoRecordAutocontrolCapture({id,body:body(),actor,idempotencyKey:"capture-key"});expect(mocks.scan).not.toHaveBeenCalled();expect(mocks.receipt).not.toHaveBeenCalled();
  });
});
