import fs from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

const dockerfile = fs.readFileSync(path.resolve(process.cwd(), "Dockerfile"), "utf8");

describe("Dockerfile storage permissions", () => {
  it("creates the active CERP storage root before switching to the node user", () => {
    const mkdirIndex = dockerfile.indexOf("RUN mkdir -p");
    const dataIndex = dockerfile.indexOf("/app/data/documents");
    const chownIndex = dockerfile.indexOf("chown -R node:node /app/data /app/uploads");
    const userIndex = dockerfile.indexOf("USER node");

    expect(mkdirIndex).toBeGreaterThanOrEqual(0);
    expect(dataIndex).toBeGreaterThan(mkdirIndex);
    expect(chownIndex).toBeGreaterThan(dataIndex);
    expect(userIndex).toBeGreaterThan(chownIndex);
  });

  it("declares the active storage root as a runtime volume", () => {
    expect(dockerfile).toContain('VOLUME ["/app/data", "/app/uploads"]');
  });
});
