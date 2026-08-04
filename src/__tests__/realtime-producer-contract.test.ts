import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ publish: vi.fn() }));

vi.mock("../sockets/sockeServer", () => ({
  publishRealtimeEvent: mocks.publish,
}));

import { emitModuleRealtimeEvent } from "../shared/realtime/realtime.service";

describe("realtime producer contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propagates a durable publish rejection to an awaiting Outillage producer", async () => {
    mocks.publish.mockRejectedValueOnce(new Error("outbox unavailable"));
    await expect(emitModuleRealtimeEvent("outillage", "stockUpdated", { id_outil: 1 }))
      .rejects.toThrow("outbox unavailable");
  });

  it("awaits all 13 legacy Outillage publications and carries no username field", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/module/outils/controllers/outil.controller.ts"),
      "utf8"
    );
    expect(source.match(/await emitModuleRealtimeEvent\("outillage"/g)).toHaveLength(13);
    expect(source).not.toMatch(/\buser\s*:/);
  });
});
