import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ client: vi.fn(), contacts: vi.fn(), contract: vi.fn(), forecasts: vi.fn(), calls: vi.fn() }));
vi.mock("../module/commande-client/services/commande-client-references.service", () => ({
  getCommandeClientReference: mocks.client, listCommandeClientContacts: mocks.contacts,
  getCommandeClientContract: mocks.contract, listCommandeClientContractForecasts: mocks.forecasts,
  listCommandeClientContractCalls: mocks.calls,
}));
vi.mock("../module/access-control/repository/access-control.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../module/access-control/repository/access-control.repository")>();
  return { ...actual, repoAuthorizationEpoch: vi.fn(), repoResolveAccessProfile: vi.fn() };
});
import * as accessRepository from "../module/access-control/repository/access-control.repository";
import { moduleAccessGate } from "../module/access-control/middlewares/module-access-gate";
import { invalidateAccessCache } from "../module/access-control/services/access-control.service";
import { getCommandeReferenceClient, getCommandeReferenceClientContract, listCommandeReferenceClientContacts, listCommandeReferenceClientContractCalls, listCommandeReferenceClientContractForecasts } from "../module/commande-client/controllers/commande-client-references.controller";

const UUID = "11111111-1111-4111-8111-111111111111";
function app() { const server = express(); server.use((_req, _res, next) => { (_req as any).user = { id: 81, username: "ORDERS_ONLY", role: "Operateur" }; next(); }); server.use(moduleAccessGate);
  server.get("/commandes/references/clients/:clientId", getCommandeReferenceClient); server.get("/commandes/references/clients/:clientId/contacts", listCommandeReferenceClientContacts);
  server.get("/commandes/references/clients/:clientId/contracts/:contractId", getCommandeReferenceClientContract);
  server.get("/commandes/references/clients/:clientId/contracts/:contractId/forecasts", listCommandeReferenceClientContractForecasts);
  server.get("/commandes/references/clients/:clientId/contracts/:contractId/calls", listCommandeReferenceClientContractCalls);
  server.get("/clients", (_req, res) => res.json({ reached: true })); server.get("/stock/articles", (_req, res) => res.json({ reached: true })); return server; }

describe("Commande references — module-only HTTP boundary", () => {
 beforeEach(() => { vi.clearAllMocks(); invalidateAccessCache(); vi.mocked(accessRepository.repoAuthorizationEpoch).mockResolvedValue(1n); vi.mocked(accessRepository.repoResolveAccessProfile).mockResolvedValue([{ is_superadmin:false,module_key:"commandes-clients",label:"Commandes",nav_page_keys:[],enabled_by_default:false,is_protected:false,is_active:true,access:"GRANTED" },{is_superadmin:false,module_key:"clients",label:"Clients",nav_page_keys:[],enabled_by_default:false,is_protected:false,is_active:true,access:"DENIED"},{is_superadmin:false,module_key:"stock",label:"Stock",nav_page_keys:[],enabled_by_default:false,is_protected:false,is_active:true,access:"DENIED" }]);
 mocks.client.mockResolvedValue({client:{client_id:"042"},biller:{id:"b",name:"B"},bill_address:{id:"a"},delivery_address:{id:"d"}}); mocks.contacts.mockResolvedValue([]); mocks.contract.mockResolvedValue({contract:{id:UUID,lines:[]},client_active:true}); mocks.forecasts.mockResolvedValue({items:[],total:0,page:1,page_size:25}); mocks.calls.mockResolvedValue({items:[],total:0,page:1,page_size:25}); });
 it("accepts the textual client id and preserves the detail envelope", async () => { const response=await request(app()).get("/commandes/references/clients/042"); expect(response.status).toBe(200); expect(response.body.biller).toEqual({id:"b",name:"B"}); expect(mocks.client).toHaveBeenCalledWith("042"); });
 it("keeps contract, forecast and calls shapes without actor history", async () => { const server=app(); expect((await request(server).get(`/commandes/references/clients/042/contracts/${UUID}`)).body).toMatchObject({contract:{id:UUID,lines:[]},client_active:true}); expect((await request(server).get(`/commandes/references/clients/042/contracts/${UUID}/forecasts`)).body).toEqual({items:[],total:0,page:1,page_size:25}); expect((await request(server).get(`/commandes/references/clients/042/contracts/${UUID}/calls`)).body).toEqual({items:[],total:0,page:1,page_size:25}); });
 it("does not reopen global Clients or Stock", async () => { const server=app(); expect((await request(server).get("/clients")).status).toBe(403); expect((await request(server).get("/stock/articles")).status).toBe(403); });
});
