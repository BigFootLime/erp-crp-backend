import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(absolute);
    if (extname(entry.name) !== ".ts" || entry.name.endsWith(".test.ts")) return [];
    return [absolute];
  });
}

describe("realtime producer contract", () => {
  it("forbids direct in-memory emit calls from production producers", () => {
    const directEmitCall = /\bemit(?:EntityChanged|AuditNew|AppNotificationCreated|ChatMessageCreated|ChatConversationRead|ChatConversationUpsert|LockUpdated|ModuleRealtimeEvent)\s*\(/;
    const offenders = productionTypeScriptFiles(sourceRoot)
      .filter((file) => !file.endsWith(join("shared", "realtime", "realtime.service.ts")))
      .filter((file) => directEmitCall.test(readFileSync(file, "utf8")))
      .map((file) => relative(sourceRoot, file));

    expect(offenders).toEqual([]);
  });

  it("keeps repository outbox producers independent from the Socket.IO bridge", () => {
    const offenders = productionTypeScriptFiles(resolve(sourceRoot, "module"))
      .filter((file) => /repository|service/.test(relative(sourceRoot, file)))
      .filter((file) => /from\s+["'][^"']*realtime\.service["']/.test(readFileSync(file, "utf8")))
      .map((file) => relative(sourceRoot, file));
    const outboxModule = readFileSync(resolve(sourceRoot, "shared/realtime/realtime-outbox.service.ts"), "utf8");

    expect(offenders).toEqual([]);
    expect(outboxModule).not.toMatch(
      /from\s+["'][^"']*(?:sockeServer|access-control|audit-logs\/repository)[^"']*["']/
    );
  });

  it("moves all 13 Outillage publications into transactional repositories/services", () => {
    const controller = readFileSync(resolve(sourceRoot, "module/outils/controllers/outil.controller.ts"), "utf8");
    const service = readFileSync(resolve(sourceRoot, "module/outils/services/outil.service.ts"), "utf8");
    const repository = readFileSync(resolve(sourceRoot, "module/outils/repository/outil.repository.ts"), "utf8");
    const publications = `${service}\n${repository}`.match(/enqueueEntityChanged\(client,/g) ?? [];

    expect(publications).toHaveLength(13);
    expect(controller).not.toMatch(/emitModuleRealtimeEvent|enqueueModuleRealtimeEvent|enqueueEntityChanged/);
    expect(service).toContain("withRealtimeOutboxTransaction");
    expect(repository).toContain("withRealtimeOutboxTransaction");
    expect(`${service}\n${repository}`).not.toMatch(/\buser\s*:/);
  });

  it("enqueues audits in application transactions and requires the privileged cross-writer backstop", () => {
    const auditRepository = readFileSync(resolve(sourceRoot, "module/audit-logs/repository/audit-logs.repository.ts"), "utf8");
    const importRepository = readFileSync(resolve(sourceRoot, "module/import-assistant/repository/import-assistant.repository.ts"), "utf8");
    const privileged = readFileSync(resolve(process.cwd(), "db/privileged/20260804_realtime_control_plane_triggers.sql"), "utf8");
    const listener = resolve(sourceRoot, "shared/realtime/audit-notify.listener.ts");

    expect(existsSync(listener)).toBe(false);
    expect(auditRepository).toContain("await enqueueAuditNew(q");
    expect(importRepository).not.toContain("INSERT INTO public.erp_audit_logs");
    expect(privileged).toContain("erp_audit_logs_realtime_outbox_trg");
  });
});
