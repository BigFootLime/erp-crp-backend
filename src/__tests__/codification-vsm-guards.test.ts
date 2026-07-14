import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { assertAcceptedEvidenceFile } from "../module/project-office/services/project-office-registers.service";

function uploadFile(name: string, mime: string, buffer: Buffer) {
  return { originalname: name, mimetype: mime, buffer, size: buffer.byteLength } as Express.Multer.File;
}

describe("Garde-fous codification et VSM", () => {
  it("utilise une séquence PostgreSQL native avec une fonction à périmètre autorisé", () => {
    const migration = fs.readFileSync(
      path.resolve(process.cwd(), "db/patches/20260713_codification_versions_of_vsm.sql"),
      "utf8"
    );
    expect(migration).toContain("CREATE SEQUENCE IF NOT EXISTS public.cerp_business_code_issue_seq");
    expect(migration).toContain("fn_next_issued_code_value");
    expect(migration).toContain("RETURN nextval('public.cerp_business_code_issue_seq'::regclass)");
    expect(migration).toContain("DEV|CMD|AFF|OF|LOT|MVT|CQ");
  });

  it("vérifie MIME, extension et signature binaire des preuves", () => {
    expect(() => assertAcceptedEvidenceFile(uploadFile("vsm.pdf", "application/pdf", Buffer.from("%PDF-1.7")))).not.toThrow();
    expect(() => assertAcceptedEvidenceFile(uploadFile("vsm.pdf", "application/pdf", Buffer.from("<xml>not-a-pdf</xml>")))).toThrow();
    expect(() => assertAcceptedEvidenceFile(uploadFile(
      "vsm.bpm",
      "application/xml",
      Buffer.from("<?xml version=\"1.0\"?><BizAgiProcessModeler />")
    ))).not.toThrow();
    expect(() => assertAcceptedEvidenceFile(uploadFile(
      "vsm.bpm",
      "application/octet-stream",
      Buffer.from("PK\x03\x04ModelInfo.xml430ac93d-0b83-45c9-96f8-635f163bd4fe.diag")
    ))).not.toThrow();
    expect(() => assertAcceptedEvidenceFile(uploadFile(
      "review.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      Buffer.from("PK\x03\x04[Content_Types].xmlppt/")
    ))).not.toThrow();
  });

  it("garde le rollback strictement bloqué après une donnée post-migration", () => {
    const rollback = fs.readFileSync(
      path.resolve(process.cwd(), "db/patches/support/20260713_codification_versions_of_vsm.rollback.sql"),
      "utf8"
    );
    expect(rollback).toContain("post-migration technical-version metadata or versions would be lost");
    expect(rollback).toContain("a non-reusable business-code number was allocated after migration");
  });
});
