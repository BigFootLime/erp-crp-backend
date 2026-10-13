import { describe,it,expect } from "vitest";
import { documentOperationLoad } from "../module/production/domain/of-document-operation-load";
import { FIXTURE_OPERATIONS_TFT } from "../../test-support/production/of-document.fixture";

describe("OF PDF follows the launched quantity and canonical planning load",()=>{
  it("computes all20 pieces when the gamme base is1",()=>{
    const op={...FIXTURE_OPERATIONS_TFT[0],quantiteBase:1,tempsUnitaire:0.05,preparation:0.333};
    const result=documentOperationLoad(op,20);
    expect(result.fabricationHours).toBe(1);
    expect(result.finalHours).toBe(80/60);
  });
  it("retains the legacy meaning when rendering old build inputs",()=>{
    const op={...FIXTURE_OPERATIONS_TFT[0],quantiteBase:40,tempsUnitaire:0.1,preparation:1};
    expect(documentOperationLoad(op)).toEqual({fabricationHours:4,finalHours:5});
  });
  it("rounds each operation once to the scheduler minute",()=>{
    const op={...FIXTURE_OPERATIONS_TFT[0],quantiteBase:1,tempsUnitaire:0.01,preparation:0};
    expect(documentOperationLoad(op,1).finalHours).toBe(1/60);
  });
  it("rejects an invalid launched quantity instead of printing a plausible charge",()=>{
    expect(()=>documentOperationLoad(FIXTURE_OPERATIONS_TFT[0],NaN)).toThrow(/launchedQuantity/);
    expect(()=>documentOperationLoad(FIXTURE_OPERATIONS_TFT[0],-1)).toThrow(/launchedQuantity/);
  });
});
