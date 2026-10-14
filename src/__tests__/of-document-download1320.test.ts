import { expect, it, vi } from "vitest";
const mock=vi.hoisted(()=>({get:vi.fn(),stored:vi.fn(),bump:vi.fn(),audit:vi.fn()}));
vi.mock("../module/production/repository/of-versioning.repository",()=>({getDocument:mock.get,bumpReprintCount:mock.bump,
  withOfTransaction:async(fn:any)=>fn({})}));
vi.mock("../module/production/services/of-document-stored-pdf",()=>({readOfDocumentStoredPdf:mock.stored}));
vi.mock("../module/project-office/repository/project-office.repository",()=>({insertAuditLog:mock.audit}));
import { reprintDocument } from "../module/production/services/of-versioning.service";
it("the legacy PDF URL reads the original but no longer counts a download as a print",async()=>{
  const document={id:"doc7",pdf_sha256:"saved-sha"},pdf=Buffer.from("exact archive");
  mock.get.mockResolvedValue(document);mock.stored.mockResolvedValue({pdf,source:"GED"});
  expect((await reprintDocument(7,"doc7",{} as any)).pdf).toBe(pdf);
  expect(mock.bump).not.toHaveBeenCalled();expect(mock.audit.mock.calls[0][2].action).toBe("OF_DOCUMENT_DOWNLOAD");
});
