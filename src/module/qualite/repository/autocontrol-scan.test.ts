import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const mocks = vi.hoisted(() => ({ root: "", scan: vi.fn() }));
vi.mock("./qualite.repository", () => ({ qualityDocumentBaseDir: () => mocks.root }));
vi.mock("../../../shared/uploads/upload-scanner", () => ({ scanUpload: mocks.scan }));
import { verifyAutocontrolScanFile } from "./autocontrol-scan";
let file: { storage_path: string; mime_type: string; size_bytes: number; sha256: string };
beforeEach(async () => {
  mocks.root=await mkdtemp(path.join(tmpdir(),"cerp-autocontrol-"));
  const buffer=Buffer.from("%PDF-1.7\nFICTITIOUS PAPER CONTROL\n");
  file={storage_path:path.join(mocks.root,"sheet.pdf"),mime_type:"application/pdf",size_bytes:buffer.length,sha256:createHash("sha256").update(buffer).digest("hex")};
  await writeFile(file.storage_path,buffer); mocks.scan.mockReset().mockResolvedValue({status:"clean"});
});
afterEach(async () => { await rm(mocks.root,{recursive:true,force:true}); });
describe("Committed paper scan integrity", () => {
  it("scans the exact bytes whose hash matches the committed document", async () => {
    expect(await verifyAutocontrolScanFile(file,true)).toBe(file.sha256);
    expect(mocks.scan).toHaveBeenCalledWith({buffer:expect.any(Buffer)});
  });
  it("checks immutable stored proof without repeating antivirus at each preview", async () => {
    await verifyAutocontrolScanFile(file,false); expect(mocks.scan).not.toHaveBeenCalled();
  });
  it.each(["infected","unavailable"])("refuses an unverified scanner result %s", async status => {
    mocks.scan.mockResolvedValue({status}); await expect(verifyAutocontrolScanFile(file,true)).rejects.toMatchObject({code:"AUTOCONTROL_SCAN_UNVERIFIED"});
  });
  it("refuses substituted file content and never sends it for acceptance", async () => {
    await writeFile(file.storage_path,"another sheet");
    await expect(verifyAutocontrolScanFile(file,true)).rejects.toMatchObject({code:"AUTOCONTROL_SCAN_CHANGED"}); expect(mocks.scan).not.toHaveBeenCalled();
  });
  it("refuses a removed physical file", async () => {
    await rm(file.storage_path); await expect(verifyAutocontrolScanFile(file,true)).rejects.toMatchObject({code:"AUTOCONTROL_SCAN_UNAVAILABLE"});
  });
  it("refuses editable documents and excessive size before opening them", async () => {
    await expect(verifyAutocontrolScanFile({...file,mime_type:"text/plain"},true)).rejects.toMatchObject({code:"AUTOCONTROL_SCAN_FORMAT"});
    await expect(verifyAutocontrolScanFile({...file,size_bytes:26*1024*1024},true)).rejects.toMatchObject({code:"AUTOCONTROL_SCAN_FORMAT"});
  });
});
